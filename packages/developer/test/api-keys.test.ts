import { DomainError, redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createApiKey, EXPIRY_OPTIONS, expiryToDate, flushApiKeyUsage, getKeyUsage, hasScope, listApiKeys, listApiKeysForStaff,
  revokeApiKey, revokeApiKeyAsStaff, verifyApiKey, recordApiError, SCOPE_GROUPS, scopesFromAccess,
} from "../src";
import { hashSecret, prefixOf } from "../src/secret";

const people: string[] = [];
const newPerson = () => { const id = randomUUID(); people.push(id); return id; };
const ctx = { ip: "203.0.113.9", kind: "rest" as const };

afterAll(async () => {
  const keys = await prisma.apiKey.findMany({ where: { personId: { in: people } }, select: { id: true, secretHash: true } });
  for (const k of keys) await redis.del(`apikey:${k.secretHash}`);
  await prisma.apiKey.deleteMany({ where: { personId: { in: people } } });
  const rl = await redis.keys("rl:apikey:*");
  if (rl.length) await redis.del(...rl);
});

describe("secret format", () => {
  it("has prefix, length and stores only the hash", async () => {
    const p = newPerson();
    const { key, secret } = await createApiKey(p, { name: "ci", scopes: ["profile:read"], expiry: "30d" });
    expect(secret).toMatch(/^ck_(live|test)_[A-Za-z0-9_-]{43}$/);
    expect(key.prefix).toBe(prefixOf(secret));
    expect(key.prefix).toHaveLength(12);
    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } });
    expect(row.secretHash).toBe(hashSecret(secret));
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(JSON.stringify(key)).not.toContain(secret);
  });
});

describe("scopes", () => {
  it("write implies read of the same feature only", () => {
    expect(hasScope({ scopes: ["leads:write"] }, "leads:read")).toBe(true);
    expect(hasScope({ scopes: ["leads:read"] }, "leads:write")).toBe(false);
    expect(hasScope({ scopes: ["leads:write"] }, "billing:read")).toBe(false);
  });
  it("builds scopes from per-feature access", () => {
    expect(scopesFromAccess({ leads: "write", billing: "read", profile: "none", bogus: "write" }).sort()).toEqual(["billing:read", "leads:write"]);
    expect(SCOPE_GROUPS.wishlist.businessScoped.write).toBe(false);
    expect(SCOPE_GROUPS.listings.businessScoped.write).toBe(true);
  });
  it("validates input", async () => {
    const p = newPerson();
    await expect(createApiKey(p, { name: "", scopes: ["profile:read"], expiry: "1d" })).rejects.toThrow();
    await expect(createApiKey(p, { name: "x".repeat(61), scopes: ["profile:read"], expiry: "1d" })).rejects.toThrow();
    await expect(createApiKey(p, { name: "x", scopes: [], expiry: "1d" })).rejects.toThrow();
  });
  it("requires a business for business write scopes, and membership", async () => {
    const p = newPerson();
    await expect(createApiKey(p, { name: "x", scopes: ["listings:write"], expiry: "1d" })).rejects.toMatchObject({ code: "validation" });
    await expect(createApiKey(p, { name: "x", scopes: ["listings:write"], expiry: "1d", businessId: randomUUID() })).rejects.toMatchObject({ code: "forbidden" });
    await expect(createApiKey(p, { name: "x", scopes: ["wishlist:write"], expiry: "1d" })).resolves.toBeTruthy();
  });
});

describe("expiry", () => {
  const now = new Date("2026-01-31T10:00:00.000Z");
  it("computes each option", () => {
    expect(EXPIRY_OPTIONS).toHaveLength(6);
    expect(expiryToDate("1d", now)?.toISOString()).toBe("2026-02-01T10:00:00.000Z");
    expect(expiryToDate("7d", now)?.toISOString()).toBe("2026-02-07T10:00:00.000Z");
    expect(expiryToDate("30d", now)?.toISOString()).toBe("2026-03-02T10:00:00.000Z");
    expect(expiryToDate("90d", now)?.toISOString()).toBe("2026-05-01T10:00:00.000Z");
    expect(expiryToDate("1y", now)?.toISOString()).toBe("2027-01-31T10:00:00.000Z");
    expect(expiryToDate("never", now)).toBeNull();
  });
});

describe("verify", () => {
  it("accepts a good key, rejects unknown/malformed", async () => {
    const p = newPerson();
    const { secret, key } = await createApiKey(p, { name: "ok", scopes: ["profile:read", "wishlist:write"], expiry: "never" });
    expect(await verifyApiKey(secret, ctx)).toMatchObject({ keyId: key.id, personId: p, scopes: ["profile:read", "wishlist:write"] });
    expect(await verifyApiKey(`ck_live_${"A".repeat(43)}`, ctx)).toBeNull();
    expect(await verifyApiKey("nonsense", ctx)).toBeNull();
    expect(await verifyApiKey("", ctx)).toBeNull();
  });

  it("rejects expired keys", async () => {
    const p = newPerson();
    const { secret, key } = await createApiKey(p, { name: "exp", scopes: ["profile:read"], expiry: "1d" });
    await prisma.apiKey.update({ where: { id: key.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await redis.del(`apikey:${hashSecret(secret)}`);
    expect(await verifyApiKey(secret, ctx)).toBeNull();
    expect((await listApiKeys(p))[0]?.status).toBe("expired");
  });

  it("revocation busts the cache immediately", async () => {
    const p = newPerson();
    const { secret, key } = await createApiKey(p, { name: "rev", scopes: ["profile:read"], expiry: "7d" });
    expect(await verifyApiKey(secret, ctx)).not.toBeNull();
    expect(await redis.get(`apikey:${hashSecret(secret)}`)).not.toBeNull();
    await revokeApiKey(p, key.id);
    expect(await redis.get(`apikey:${hashSecret(secret)}`)).toBeNull();
    expect(await verifyApiKey(secret, ctx)).toBeNull();
    expect((await listApiKeys(p))[0]?.status).toBe("revoked");
    await expect(revokeApiKey(newPerson(), key.id)).rejects.toBeInstanceOf(DomainError);
  });

  it("staff revoke records revokedBy and appears in staff list without secrets", async () => {
    const p = newPerson();
    const staff = randomUUID();
    const { secret, key } = await createApiKey(p, { name: "staffrev", scopes: ["profile:read"], expiry: "7d" });
    await verifyApiKey(secret, ctx);
    await revokeApiKeyAsStaff(key.id, staff);
    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } });
    expect(row.revokedBy).toBe(staff);
    expect(await verifyApiKey(secret, ctx)).toBeNull();
    const list = await listApiKeysForStaff({ q: p, status: "revoked" });
    expect(list.items.map((i) => i.id)).toEqual([key.id]);
    expect(JSON.stringify(list)).not.toContain(row.secretHash);
  });

  it("rate limits per key", async () => {
    const p = newPerson();
    const { secret } = await createApiKey(p, { name: "rl", scopes: ["profile:read"], expiry: "1d" });
    const prev = process.env.API_KEY_RATE_MCP;
    process.env.API_KEY_RATE_MCP = "2";
    try {
      const mcp = { ip: null, kind: "mcp" as const };
      await verifyApiKey(secret, mcp);
      await verifyApiKey(secret, mcp);
      await expect(verifyApiKey(secret, mcp)).rejects.toMatchObject({ code: "rate_limited" });
    } finally {
      if (prev === undefined) delete process.env.API_KEY_RATE_MCP; else process.env.API_KEY_RATE_MCP = prev;
    }
  });
});

describe("usage", () => {
  it("flushes Redis counters into ApiKeyUsageDaily idempotently", async () => {
    const p = newPerson();
    const { secret, key } = await createApiKey(p, { name: "use", scopes: ["profile:read"], expiry: "1d" });
    await verifyApiKey(secret, ctx);
    await verifyApiKey(secret, ctx);
    await verifyApiKey(secret, { ip: null, kind: "mcp" });
    await recordApiError(key.id);
    const before = await getKeyUsage(p, key.id, 7);
    expect(before).toHaveLength(7);
    expect(before.at(-1)).toMatchObject({ requests: 3, errors: 1, mcpCalls: 1 });

    await flushApiKeyUsage();
    const day = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const row = await prisma.apiKeyUsageDaily.findUniqueOrThrow({ where: { apiKeyId_day: { apiKeyId: key.id, day } } });
    expect(row).toMatchObject({ requests: 3, errors: 1, mcpCalls: 1 });

    await flushApiKeyUsage(); // nothing new: no double count
    expect((await getKeyUsage(p, key.id, 7)).at(-1)).toMatchObject({ requests: 3, errors: 1, mcpCalls: 1 });

    await verifyApiKey(secret, ctx);
    await flushApiKeyUsage();
    const again = await prisma.apiKeyUsageDaily.findUniqueOrThrow({ where: { apiKeyId_day: { apiKeyId: key.id, day } } });
    expect(again.requests).toBe(4);
    await expect(getKeyUsage(newPerson(), key.id)).rejects.toBeInstanceOf(DomainError);
  });
});
