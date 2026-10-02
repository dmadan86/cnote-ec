import { DomainError, redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ACTIVE_KEYS, createApiKey, flushApiKeyUsage, getKeyUsage, listApiKeys, listApiKeysForStaff, recordApiError, revokeAllApiKeysForPerson,
  revokeApiKey, revokeApiKeyAsStaff, verifyApiKey, worker,
} from "../src";
import { cacheKey } from "../src/keys";
import { hashSecret, generateSecret } from "../src/secret";
import { bumpUsage, loadUsage } from "../src/usage";
import { logExpiringKeys } from "../src/worker";

const people: string[] = [];
const newPerson = () => {
  const id = randomUUID();
  people.push(id);
  return id;
};
/** Delete only THIS file's rate-limit counters: a global `rl:apikey:*` wipe would reset another file's counter mid-test. */
const delOwnRateLimits = async (keyIds: string[], personIds: string[]) => {
  const patterns = [...keyIds.flatMap((id) => [`rl:apikey:rest:${id}:*`, `rl:apikey:mcp:${id}:*`]), ...personIds.map((p) => `rl:apikey:create:${p}:*`)];
  for (const pat of patterns) {
    const ks = await redis.keys(pat);
    if (ks.length) await redis.del(...ks);
  }
};
const ctx = { ip: "203.0.113.9", kind: "rest" as const };
/** Freeze Date mid-minute so fixed-window rate limits can't roll over during a test. */
const freezeMidWindow = () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Math.floor(Date.now() / 60_000) * 60_000 + 10_000);
};
const mk = (p: string, over: Partial<Parameters<typeof createApiKey>[1]> = {}) =>
  createApiKey(p, { name: "k", scopes: ["profile:read"], expiry: "30d", ...over });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.API_KEY_RATE_REST;
  delete process.env.API_KEY_RATE_MCP;
});
afterAll(async () => {
  const keys = await prisma.apiKey.findMany({ where: { personId: { in: people } }, select: { id: true, secretHash: true } });
  for (const k of keys) await redis.del(cacheKey(k.secretHash), `apikey:touch:${k.id}`);
  await prisma.apiKeyUsageDaily.deleteMany({ where: { apiKeyId: { in: keys.map((k) => k.id) } } });
  await prisma.apiKey.deleteMany({ where: { personId: { in: people } } });
  await delOwnRateLimits(keys.map((k) => k.id), people);
  const us = await redis.keys("apikey:usage:*");
  for (const k of us) if (keys.some((x) => k.includes(x.id))) await redis.del(k);
});

describe("createApiKey limits", () => {
  it("rate-limits creation at 10/hour per person (11th rejected), other people unaffected", async () => {
    const p = newPerson();
    for (let i = 0; i < 10; i++) await mk(p, { name: `n${i}` });
    await expect(mk(p)).rejects.toMatchObject({ code: "rate_limited" });
    await expect(mk(newPerson())).resolves.toBeTruthy();
  });
  it("caps active keys at MAX_ACTIVE_KEYS; revoked and expired keys do not count", async () => {
    const p = newPerson();
    const now = new Date();
    await prisma.apiKey.createMany({
      data: Array.from({ length: MAX_ACTIVE_KEYS + 2 }, (_, i) => {
        const s = generateSecret();
        return {
          personId: p, name: `bulk${i}`, prefix: s.slice(0, 12), secretHash: hashSecret(s), scopes: ["profile:read"],
          expiresAt: i === 0 ? new Date(now.getTime() - 1000) : null, revokedAt: i === 1 ? now : null,
        };
      }),
    });
    // 27 rows, 1 expired + 1 revoked -> 25 active: at cap
    await expect(mk(p)).rejects.toMatchObject({ code: "conflict" });
    const one = await prisma.apiKey.findFirstOrThrow({ where: { personId: p, revokedAt: null, expiresAt: null } });
    await revokeApiKey(p, one.id);
    await expect(mk(p)).resolves.toBeTruthy();
  });
  it("retries on prefix collision (P2002) and gives up after 5", async () => {
    const p = newPerson();
    const spy = vi.spyOn(prisma.apiKey, "create");
    spy.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    const { key } = await mk(p);
    expect(key.id).toBeTruthy();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockReset();
    spy.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    await expect(mk(p)).rejects.toThrow("unique API key prefix");
    expect(spy).toHaveBeenCalledTimes(5);
    spy.mockReset();
    spy.mockRejectedValue(new Error("db down"));
    await expect(mk(p)).rejects.toThrow("db down");
  });
  it("dedupes scopes, trims the name, defaults business to null, stores expiry per option", async () => {
    const p = newPerson();
    const { key } = await createApiKey(p, { name: "  spaced  ", scopes: ["profile:read", "profile:read", "search:read"], expiry: "never" });
    expect(key).toMatchObject({ name: "spaced", scopes: ["profile:read", "search:read"], businessId: null, expiresAt: null, status: "active" });
    const { key: k7 } = await mk(p, { expiry: "7d" });
    expect(Date.parse(k7.expiresAt!) - Date.now()).toBeGreaterThan(6.99 * 86_400_000);
    await expect(createApiKey(p, { name: "x", scopes: ["profile:read"], expiry: "2d" as never })).rejects.toThrow();
    await expect(createApiKey(p, { name: "x", scopes: ["nope" as never], expiry: "1d" })).rejects.toThrow();
    await expect(createApiKey(p, { name: "x", scopes: ["profile:read"], expiry: "1d", businessId: "not-uuid" })).rejects.toThrow();
  });
  it("lists newest first with status", async () => {
    const p = newPerson();
    const a = await mk(p, { name: "a" });
    const b = await mk(p, { name: "b" });
    const list = await listApiKeys(p);
    expect(list.map((k) => k.id)).toEqual([b.key.id, a.key.id]);
    expect(await listApiKeys(newPerson())).toEqual([]);
  });
});

describe("verifyApiKey", () => {
  it("negative-caches unknown keys for ~30s, then a key later inserted with that hash is seen only after expiry of the negative entry", async () => {
    const secret = generateSecret();
    expect(await verifyApiKey(secret, ctx)).toBeNull();
    const ck = cacheKey(hashSecret(secret));
    expect(await redis.get(ck)).toBe("null");
    const ttl = await redis.ttl(ck);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
    // insert the key directly: still rejected while negative entry is cached
    const p = newPerson();
    await prisma.apiKey.create({ data: { personId: p, name: "late", prefix: secret.slice(0, 12), secretHash: hashSecret(secret), scopes: ["profile:read"] } });
    expect(await verifyApiKey(secret, ctx)).toBeNull();
    await redis.del(ck);
    expect(await verifyApiKey(secret, ctx)).toMatchObject({ personId: p });
    await redis.del(ck);
  });
  it("positive cache TTL <= 60s and is capped by time-to-expiry", async () => {
    const p = newPerson();
    const { secret, key } = await mk(p);
    await verifyApiKey(secret, ctx);
    expect(await redis.ttl(cacheKey(hashSecret(secret)))).toBeLessThanOrEqual(60);
    const soon = await mk(p);
    await prisma.apiKey.update({ where: { id: soon.key.id }, data: { expiresAt: new Date(Date.now() + 5000) } });
    await verifyApiKey(soon.secret, ctx);
    expect(await redis.ttl(cacheKey(hashSecret(soon.secret)))).toBeLessThanOrEqual(5);
    void key;
  });
  it("a cached entry stops verifying the moment its expiry passes (fake clock), without DB access", async () => {
    const p = newPerson();
    const { secret, key } = await mk(p);
    const exp = new Date(Date.now() + 3600_000);
    await prisma.apiKey.update({ where: { id: key.id }, data: { expiresAt: exp } });
    await redis.del(cacheKey(hashSecret(secret)));
    expect(await verifyApiKey(secret, ctx)).not.toBeNull();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(exp.getTime() - 1));
    expect(await verifyApiKey(secret, ctx)).not.toBeNull();
    vi.setSystemTime(new Date(exp.getTime()));
    expect(await verifyApiKey(secret, ctx)).toBeNull();
  });
  it("cached revoked entry is rejected", async () => {
    const p = newPerson();
    const { secret, key } = await mk(p);
    await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    await redis.del(cacheKey(hashSecret(secret)));
    expect(await verifyApiKey(secret, ctx)).toBeNull();
    expect(await verifyApiKey(secret, ctx)).toBeNull(); // via cache
  });
  it("REST limit boundary: N allowed, N+1 rejected; REST and MCP buckets are independent", async () => {
    freezeMidWindow();
    const p = newPerson();
    const { secret } = await mk(p);
    process.env.API_KEY_RATE_REST = "3";
    process.env.API_KEY_RATE_MCP = "1";
    for (let i = 0; i < 3; i++) expect(await verifyApiKey(secret, ctx)).not.toBeNull();
    await expect(verifyApiKey(secret, ctx)).rejects.toBeInstanceOf(DomainError);
    expect(await verifyApiKey(secret, { ip: null, kind: "mcp" })).not.toBeNull();
    await expect(verifyApiKey(secret, { ip: null, kind: "mcp" })).rejects.toMatchObject({ code: "rate_limited" });
  });
  it("rate limits are per key, not per person", async () => {
    freezeMidWindow();
    const p = newPerson();
    const a = await mk(p);
    const b = await mk(p);
    process.env.API_KEY_RATE_REST = "1";
    expect(await verifyApiKey(a.secret, ctx)).not.toBeNull();
    await expect(verifyApiKey(a.secret, ctx)).rejects.toBeDefined();
    expect(await verifyApiKey(b.secret, ctx)).not.toBeNull();
  });
  it("a failing usage counter never fails the request", async () => {
    const p = newPerson();
    const { secret } = await mk(p);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const multi = vi.spyOn(redis, "multi").mockImplementation(() => {
      throw new Error("redis down");
    });
    expect(await verifyApiKey(secret, ctx)).not.toBeNull();
    expect(multi).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });
  it("filters unknown stored scopes out of the principal", async () => {
    const p = newPerson();
    const { secret, key } = await mk(p);
    await prisma.apiKey.update({ where: { id: key.id }, data: { scopes: ["profile:read", "old:scope"] } });
    await redis.del(cacheKey(hashSecret(secret)));
    expect((await verifyApiKey(secret, ctx))!.scopes).toEqual(["profile:read"]);
  });
  it("rejects non-string / oversize secrets without touching Redis", async () => {
    const get = vi.spyOn(redis, "get");
    expect(await verifyApiKey(undefined as never, ctx)).toBeNull();
    expect(await verifyApiKey("x".repeat(500), ctx)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("revocation", () => {
  it("revoke is idempotent, keeps the first revokedAt, and validates ids", async () => {
    const p = newPerson();
    const { key } = await mk(p);
    await revokeApiKey(p, key.id);
    const first = (await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } })).revokedAt!;
    await revokeApiKey(p, key.id);
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } })).revokedAt!.getTime()).toBe(first.getTime());
    await expect(revokeApiKey(p, "nope")).rejects.toMatchObject({ code: "not_found" });
    await expect(revokeApiKey(p, randomUUID())).rejects.toMatchObject({ code: "not_found" });
    await expect(revokeApiKeyAsStaff("nope", randomUUID())).rejects.toMatchObject({ code: "not_found" });
    await expect(revokeApiKeyAsStaff(randomUUID(), randomUUID())).rejects.toMatchObject({ code: "not_found" });
  });
  it("another person cannot revoke; staff can revoke any key and cache is busted", async () => {
    const p = newPerson();
    const { key, secret } = await mk(p);
    await verifyApiKey(secret, ctx);
    await expect(revokeApiKey(newPerson(), key.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await verifyApiKey(secret, ctx)).not.toBeNull();
    const staff = randomUUID();
    await revokeApiKeyAsStaff(key.id, staff);
    expect(await redis.get(cacheKey(hashSecret(secret)))).toBeNull();
    expect(await verifyApiKey(secret, ctx)).toBeNull();
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } })).revokedBy).toBe(staff);
  });
  it("revokeAllApiKeysForPerson (erasure) revokes only active keys, busts caches, returns count", async () => {
    const p = newPerson();
    const a = await mk(p);
    const b = await mk(p);
    const c = await mk(p);
    await revokeApiKey(p, c.key.id);
    await verifyApiKey(a.secret, ctx);
    await verifyApiKey(b.secret, ctx);
    const other = await mk(newPerson());
    expect(await revokeAllApiKeysForPerson(p)).toBe(2);
    expect(await revokeAllApiKeysForPerson(p)).toBe(0);
    expect(await verifyApiKey(a.secret, ctx)).toBeNull();
    expect(await verifyApiKey(b.secret, ctx)).toBeNull();
    expect(await verifyApiKey(other.secret, ctx)).not.toBeNull();
    expect((await listApiKeys(p)).every((k) => k.status === "revoked")).toBe(true);
  });
  it("the worker handler for DataErasureRequested revokes the person's keys", async () => {
    const p = newPerson();
    const { secret } = await mk(p);
    await worker.handlers!.DataErasureRequested!({ payload: { personId: p } } as never);
    expect(await verifyApiKey(secret, ctx)).toBeNull();
  });
});

describe("usage", () => {
  it("bumpUsage touches lastUsedAt/Ip once per minute and truncates ip to 64 chars", async () => {
    const p = newPerson();
    const { key } = await mk(p);
    await bumpUsage(key.id, "rest", "9".repeat(100));
    await vi.waitFor(async () => {
      const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } });
      expect(row.lastUsedIp).toBe("9".repeat(64));
      expect(row.lastUsedAt).not.toBeNull();
    });
    await bumpUsage(key.id, "rest", "1.2.3.4"); // within the minute: no touch
    await new Promise((r) => setImmediate(r));
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } })).lastUsedIp).toBe("9".repeat(64));
  });
  it("bumpUsage for a deleted key does not throw", async () => {
    await expect(bumpUsage(randomUUID(), "mcp", null)).resolves.toBeUndefined();
  });
  it("flush moves counters exactly once under concurrent flushers (no double count, no loss)", async () => {
    const p = newPerson();
    const { key } = await mk(p);
    for (let i = 0; i < 5; i++) await bumpUsage(key.id, "rest", null);
    await recordApiError(key.id);
    await Promise.all([flushApiKeyUsage(), flushApiKeyUsage(), flushApiKeyUsage()]);
    const rows = await prisma.apiKeyUsageDaily.findMany({ where: { apiKeyId: key.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requests: 5, errors: 1, mcpCalls: 0 });
  });
  it("flush drops counters of deleted keys (FK) and restores counters when the DB fails", async () => {
    const ghost = randomUUID();
    await bumpUsage(ghost, "rest", null);
    const n1 = await flushApiKeyUsage();
    expect(n1).toBeGreaterThanOrEqual(0);
    expect(await redis.keys(`apikey:usage:${ghost}:*`)).toHaveLength(0);

    const p = newPerson();
    const { key } = await mk(p);
    await bumpUsage(key.id, "mcp", null);
    const spy = vi.spyOn(prisma.apiKeyUsageDaily, "upsert").mockRejectedValueOnce(new Error("pg down"));
    await expect(flushApiKeyUsage()).rejects.toThrow("pg down");
    spy.mockRestore();
    const usage = await loadUsage(key.id, 1);
    expect(usage[0]).toMatchObject({ requests: 1, mcpCalls: 1 });
    await flushApiKeyUsage();
    expect((await prisma.apiKeyUsageDaily.findFirstOrThrow({ where: { apiKeyId: key.id } })).requests).toBe(1);
  });
  it("flush ignores foreign keys and zero-count hashes", async () => {
    await redis.hset("apikey:usage:not-a-uuid:2026-01-01", "requests", "5");
    const id = randomUUID();
    await redis.hset(`apikey:usage:${id}:2026-01-01`, "requests", "0");
    await flushApiKeyUsage();
    expect(await redis.exists("apikey:usage:not-a-uuid:2026-01-01")).toBe(1);
    expect(await redis.exists(`apikey:usage:${id}:2026-01-01`)).toBe(0);
    await redis.del("apikey:usage:not-a-uuid:2026-01-01");
  });
  it("loadUsage zero-fills a series of exactly `days` entries, oldest first; getKeyUsage clamps days to 1..90", async () => {
    const p = newPerson();
    const { key } = await mk(p);
    const s = await loadUsage(key.id, 5, new Date("2026-03-10T12:00:00Z"));
    expect(s.map((d) => d.day)).toEqual(["2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"]);
    expect(s.every((d) => d.requests === 0 && d.errors === 0 && d.mcpCalls === 0)).toBe(true);
    expect(await getKeyUsage(p, key.id, 0)).toHaveLength(1);
    expect(await getKeyUsage(p, key.id, 1000)).toHaveLength(90);
    expect(await getKeyUsage(p, key.id, 2.9)).toHaveLength(2);
    expect(await getKeyUsage(p, key.id)).toHaveLength(30);
    await expect(getKeyUsage(p, "nope")).rejects.toMatchObject({ code: "not_found" });
  });
  it("loadUsage sums flushed rows with pending counters and ignores rows outside the window", async () => {
    const p = newPerson();
    const { key } = await mk(p);
    const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    await prisma.apiKeyUsageDaily.create({ data: { apiKeyId: key.id, day: today, requests: 10, errors: 2, mcpCalls: 3 } });
    await bumpUsage(key.id, "mcp", null);
    const s = await loadUsage(key.id, 3);
    expect(s.at(-1)).toMatchObject({ requests: 11, errors: 2, mcpCalls: 4 });
  });
});

describe("worker jobs", () => {
  it("logExpiringKeys counts only active keys expiring within 7 days", async () => {
    const p = newPerson();
    const soon = await mk(p);
    const later = await mk(p);
    const gone = await mk(p);
    const never = await mk(p, { expiry: "never" });
    const now = new Date();
    await prisma.apiKey.update({ where: { id: soon.key.id }, data: { expiresAt: new Date(now.getTime() + 3 * 86_400_000) } });
    await prisma.apiKey.update({ where: { id: later.key.id }, data: { expiresAt: new Date(now.getTime() + 20 * 86_400_000) } });
    await prisma.apiKey.update({ where: { id: gone.key.id }, data: { expiresAt: new Date(now.getTime() + 2 * 86_400_000), revokedAt: now } });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await logExpiringKeys(now);
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(p));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(soon.key.prefix);
    void never;
    for (const job of worker.jobs!) {
      await (job.run as () => Promise<void>)();
    }
  });
});

describe("listApiKeysForStaff", () => {
  it("filters by status, name/prefix/id search and paginates without leaking secrets", async () => {
    const p = newPerson();
    const tag = `stf${randomUUID().slice(0, 6)}`;
    const active = await mk(p, { name: `${tag}-active` });
    const revoked = await mk(p, { name: `${tag}-revoked` });
    const expired = await mk(p, { name: `${tag}-expired` });
    await revokeApiKey(p, revoked.key.id);
    await prisma.apiKey.update({ where: { id: expired.key.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const ids = async (o: Parameters<typeof listApiKeysForStaff>[0]) => (await listApiKeysForStaff(o)).items.map((i) => i.id);
    expect(await ids({ q: tag, status: "active" })).toEqual([active.key.id]);
    expect(await ids({ q: tag, status: "revoked" })).toEqual([revoked.key.id]);
    expect(await ids({ q: tag, status: "expired" })).toEqual([expired.key.id]);
    expect((await ids({ q: tag })).sort()).toEqual([active.key.id, revoked.key.id, expired.key.id].sort());
    expect(await ids({ q: tag.toUpperCase(), status: "active" })).toEqual([active.key.id]);
    expect(await ids({ q: active.key.prefix, status: "active" })).toContain(active.key.id);
    expect((await ids({ q: p })).length).toBe(3); // personId search
    expect(await ids({ q: active.key.id })).toEqual([active.key.id]);
    expect(await ids({ q: "   " })).not.toHaveLength(0);
    const page = await listApiKeysForStaff({ q: p });
    expect(page.items.every((i) => i.personId === p && Array.isArray(i.usage) && i.usage.length === 14)).toBe(true);
    expect(JSON.stringify(page)).not.toMatch(/secretHash|ck_test_[A-Za-z0-9_-]{43}/);
  });
  it("paginates 50 per page with cursor and ignores an invalid cursor", async () => {
    const p = newPerson();
    await prisma.apiKey.createMany({
      data: Array.from({ length: 53 }, (_, i) => {
        const s = generateSecret();
        return { personId: p, name: `pg${i}`, prefix: s.slice(0, 12), secretHash: hashSecret(s), scopes: ["profile:read"] };
      }),
    });
    const p1 = await listApiKeysForStaff({ q: p });
    expect(p1.items).toHaveLength(50);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await listApiKeysForStaff({ q: p, cursor: p1.nextCursor! });
    expect(p2.items).toHaveLength(3);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size).toBe(53);
    expect((await listApiKeysForStaff({ q: p, cursor: "garbage" })).items).toHaveLength(50);
  });
});
