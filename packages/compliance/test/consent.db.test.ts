import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { anonymizeCookieConsentReceipts, cookieConsentSchema, cookieConsentStats, foldConsentStats, iterateCookieConsentReceipts, listCookieConsentReceipts, purgeCookieConsentReceipts, recordCookieConsent, RETENTION_POLICIES, runRetention, searchCookieConsentReceipts, windowDays } from "../src";

const tag = randomUUID().replace(/-/g, "");
const consentIds: string[] = [];
const personIds: string[] = [];
const cid = () => {
  const id = randomUUID().replace(/-/g, "");
  consentIds.push(id);
  return id;
};
const base = (consentId: string) => ({ consentId, policyVersion: 1, analytics: true, marketing: false, gpc: false, action: "custom" as const, locale: "en" as const });

afterAll(async () => {
  await prisma.cookieConsentReceipt.deleteMany({ where: { consentId: { in: consentIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

describe("cookieConsentSchema (strict validation)", () => {
  const ok = base("a".repeat(32));
  it("accepts a well-formed receipt", () => {
    expect(cookieConsentSchema.safeParse(ok).success).toBe(true);
  });
  it("rejects malformed ids, versions, actions, locales and unknown keys (no IP / user agent smuggling)", () => {
    for (const bad of [
      { ...ok, consentId: "A".repeat(32) },
      { ...ok, consentId: "a".repeat(31) },
      { ...ok, policyVersion: 0 },
      { ...ok, policyVersion: 1.5 },
      { ...ok, action: "maybe" },
      { ...ok, locale: "xx" },
      { ...ok, analytics: "yes" },
      { ...ok, ip: "1.2.3.4" },
      { ...ok, userAgent: "Mozilla" },
      { ...ok, gpc: undefined },
    ]) expect(cookieConsentSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
  it("keeps actions consistent with the choices", () => {
    expect(cookieConsentSchema.safeParse({ ...ok, action: "accept_all", analytics: false }).success).toBe(false);
    expect(cookieConsentSchema.safeParse({ ...ok, action: "accept_all", analytics: true, marketing: false, gpc: true }).success).toBe(true); // GPC: marketing stays off
    expect(cookieConsentSchema.safeParse({ ...ok, action: "reject_all", analytics: true }).success).toBe(false);
    expect(cookieConsentSchema.safeParse({ ...ok, action: "reject_all", analytics: false, marketing: false }).success).toBe(true);
    expect(cookieConsentSchema.safeParse({ ...ok, action: "withdraw", analytics: false, marketing: false }).success).toBe(true);
  });
});

describe("recordCookieConsent", () => {
  it("appends an immutable receipt with per-category choices, policy version, gpc, action, locale and time; nothing else", async () => {
    const id = cid();
    const out = await recordCookieConsent({ ...base(id), marketing: true, gpc: true, locale: "hi", action: "custom" });
    const row = await prisma.cookieConsentReceipt.findUniqueOrThrow({ where: { id: out.id } });
    expect(row).toMatchObject({ consentId: id, policyVersion: 1, analytics: true, marketing: true, gpc: true, action: "custom", locale: "hi", personId: null });
    expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
    expect(out.createdAt).toBe(row.createdAt.toISOString());
    // data minimisation: the table has no IP / user-agent columns at all
    const cols = (await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'cookie_consent_receipts'`).map((c) => c.column_name);
    expect(cols.sort()).toEqual(["action", "analytics", "app", "client_at", "consent_id", "created_at", "functional", "gpc", "id", "locale", "marketing", "person_id", "policy_version", "registry_hash"]);
  });
  it("throws a validation DomainError for invalid input and writes nothing", async () => {
    const id = cid();
    await expect(recordCookieConsent({ ...base(id), action: "bogus" })).rejects.toMatchObject({ code: "validation" });
    await expect(recordCookieConsent({ ...base(id), extra: 1 })).rejects.toMatchObject({ code: "validation" });
    expect(await prisma.cookieConsentReceipt.count({ where: { consentId: id } })).toBe(0);
  });
  it("links the person when signed in, and ignores a malformed person id", async () => {
    const p = await prisma.person.create({ data: { email: `cc-${tag}@example.test` } });
    personIds.push(p.id);
    const a = cid();
    await recordCookieConsent(base(a), { personId: p.id });
    const b = cid();
    await recordCookieConsent(base(b), { personId: "not-a-uuid" });
    expect((await listCookieConsentReceipts(a))[0]?.personId).toBe(p.id);
    expect((await listCookieConsentReceipts(b))[0]?.personId).toBeNull();
  });
  it("keeps the history of one browser id in order (accept, then withdraw)", async () => {
    const id = cid();
    await recordCookieConsent({ ...base(id), action: "accept_all", marketing: true });
    await new Promise((r) => setTimeout(r, 5));
    await recordCookieConsent({ ...base(id), action: "withdraw", analytics: false, marketing: false });
    const list = await listCookieConsentReceipts(id);
    expect(list.map((r) => r.action)).toEqual(["accept_all", "withdraw"]);
    expect(list[1]).toMatchObject({ analytics: false, marketing: false });
  });
});

describe("retention", () => {
  it("registers a 3-year policy for the receipts with a documented legal basis", () => {
    const p = RETENTION_POLICIES.find((x) => x.name === "compliance.cookie_consent_receipts")!;
    expect(p).toBeTruthy();
    expect(p.module).toBe("compliance");
    expect(windowDays(p, {})).toBe(1095);
    expect(p.legalBasis).toMatch(/s\.6\(10\)/);
    expect(p.supportsDryRun).toBe(true);
    expect(windowDays(p, { RETENTION_COOKIE_CONSENT_RECEIPTS_DAYS: "400" })).toBe(400);
  });
  it("purges only receipts older than the cut-off (dry run counts without deleting)", async () => {
    const oldId = cid();
    const freshId = cid();
    // The table is append-only at the DB level (M5): backdate by inserting an old row, never by updating one.
    const backdated = new Date(Date.now() - 1100 * 86_400_000);
    await prisma.cookieConsentReceipt.create({ data: { consentId: oldId, policyVersion: 1, analytics: true, marketing: false, gpc: false, action: "custom", locale: "en", createdAt: backdated } });
    await recordCookieConsent(base(freshId));
    const cutoff = new Date(Date.now() - 1095 * 86_400_000);
    const dry = await purgeCookieConsentReceipts(cutoff, { dryRun: true });
    expect(dry).toBeGreaterThanOrEqual(1);
    expect(await prisma.cookieConsentReceipt.count({ where: { consentId: oldId } })).toBe(1);
    expect(await purgeCookieConsentReceipts(cutoff)).toBeGreaterThanOrEqual(1);
    expect(await prisma.cookieConsentReceipt.count({ where: { consentId: oldId } })).toBe(0);
    expect(await prisma.cookieConsentReceipt.count({ where: { consentId: freshId } })).toBe(1);
  });
  it("runs through the retention framework and records a RetentionRun", async () => {
    const p = RETENTION_POLICIES.find((x) => x.name === "compliance.cookie_consent_receipts")!;
    const [r] = await runRetention({ policies: [p], dryRun: true });
    expect(r).toMatchObject({ policy: p.name, module: "compliance", dryRun: true, error: null });
    await prisma.retentionRun.deleteMany({ where: { policy: `${p.name} (dry-run)`, module: "compliance" } });
  });
});

describe("idempotent receipts (consentId + at)", () => {
  it("a resend of the same receipt inserts nothing and answers with the stored row", async () => {
    const id = cid();
    const a = await recordCookieConsent({ ...base(id), at: 1_790_000_000 }, { registryHash: "a".repeat(64) });
    const b = await recordCookieConsent({ ...base(id), at: 1_790_000_000 }, { registryHash: "a".repeat(64) });
    expect(a.duplicate).toBe(false);
    expect(b).toMatchObject({ id: a.id, duplicate: true });
    expect(await prisma.cookieConsentReceipt.count({ where: { consentId: id } })).toBe(1);
  });
  it("concurrent resends still leave exactly one row", async () => {
    const id = cid();
    const rs = await Promise.all([1, 2, 3, 4].map(() => recordCookieConsent({ ...base(id), at: 1_790_000_010 })));
    expect(new Set(rs.map((r) => r.id)).size).toBe(1);
    expect(await prisma.cookieConsentReceipt.count({ where: { consentId: id } })).toBe(1);
  });
  it("different timestamps of one browser are different receipts; without `at` nothing is deduplicated", async () => {
    const id = cid();
    await recordCookieConsent({ ...base(id), at: 1_790_000_020 });
    await recordCookieConsent({ ...base(id), at: 1_790_000_021, action: "withdraw", analytics: false });
    await recordCookieConsent(base(id));
    await recordCookieConsent(base(id));
    expect(await prisma.cookieConsentReceipt.count({ where: { consentId: id } })).toBe(4);
  });
  it("stores the policy snapshot hash (only a real sha256) and the browser time", async () => {
    const id = cid();
    await recordCookieConsent({ ...base(id), at: 1_790_000_030 }, { registryHash: "b".repeat(64) });
    const other = cid();
    await recordCookieConsent({ ...base(other), at: 1_790_000_031 }, { registryHash: "not-a-hash" });
    expect((await listCookieConsentReceipts(id))[0]).toMatchObject({ registryHash: "b".repeat(64), clientAt: 1_790_000_030 });
    expect((await listCookieConsentReceipts(other))[0]?.registryHash).toBeNull();
    await expect(recordCookieConsent({ ...base(id), at: -5 })).rejects.toMatchObject({ code: "validation" });
  });
});

describe("staff search (keyset) and export", () => {
  it("finds by consent id or person id, filters, and pages newest-first without gaps or repeats", async () => {
    const p = await prisma.person.create({ data: { email: `cs-${tag}@example.test` } });
    personIds.push(p.id);
    const id = cid();
    for (let i = 0; i < 5; i++) {
      await recordCookieConsent({ ...base(id), at: 1_790_100_000 + i, action: i === 4 ? "withdraw" : "custom", analytics: i !== 4 }, { personId: p.id });
    }
    const first = await searchCookieConsentReceipts({ q: id, limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await searchCookieConsentReceipts({ q: id, limit: 2, cursor: first.nextCursor });
    const third = await searchCookieConsentReceipts({ q: id, limit: 2, cursor: second.nextCursor });
    expect(third.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items, ...third.items].map((r) => r.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(first.items[0]!.action).toBe("withdraw"); // newest first
    const byPerson = await searchCookieConsentReceipts({ q: p.id, limit: 50 });
    expect(byPerson.items.map((r) => r.consentId)).toEqual(Array(5).fill(id));
    expect((await searchCookieConsentReceipts({ consentId: id, action: "withdraw" })).items).toHaveLength(1);
    expect((await searchCookieConsentReceipts({ consentId: id, policyVersion: 2 })).items).toHaveLength(0);
    expect((await searchCookieConsentReceipts({ consentId: id, from: new Date(Date.now() + 86_400_000) })).items).toHaveLength(0);
    expect((await searchCookieConsentReceipts({ consentId: id, to: new Date(Date.now() + 86_400_000) })).items).toHaveLength(5);
  });
  it("an unparseable query matches nothing (never everything) and a forged cursor is rejected", async () => {
    expect((await searchCookieConsentReceipts({ q: "hello world" })).items).toEqual([]);
    expect((await searchCookieConsentReceipts({ personId: "nope" })).items).toEqual([]);
    await expect(searchCookieConsentReceipts({ cursor: "garbage" })).rejects.toMatchObject({ code: "validation" });
  });
  it("streams every matching row in pages and honours maxRows", async () => {
    const id = cid();
    for (let i = 0; i < 7; i++) await recordCookieConsent({ ...base(id), at: 1_790_200_000 + i });
    const all: string[] = [];
    for await (const r of iterateCookieConsentReceipts({ consentId: id }, { pageSize: 3 })) all.push(r.id);
    expect(new Set(all).size).toBe(7);
    const capped: string[] = [];
    for await (const r of iterateCookieConsentReceipts({ consentId: id }, { pageSize: 3, maxRows: 4 })) capped.push(r.id);
    expect(capped).toHaveLength(4);
  });
});

describe("cookieConsentStats", () => {
  it("folds action mix per IST day and per language, with the GPC share", () => {
    const s = foldConsentStats(
      [
        { day: "2026-10-01", locale: "en", action: "accept_all", gpc: false, n: 6 },
        { day: "2026-10-01", locale: "hi", action: "reject_all", gpc: true, n: 3 },
        { day: "2026-10-02", locale: "en", action: "withdraw", gpc: false, n: 1 },
        { day: "2026-10-02", locale: "en", action: "bogus", gpc: false, n: 99 },
      ],
      { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-03T00:00:00Z") },
    );
    expect(s.total).toBe(10);
    expect(s.daily).toEqual([
      { day: "2026-10-01", accept_all: 6, reject_all: 3, custom: 0, withdraw: 0, total: 9 },
      { day: "2026-10-02", accept_all: 0, reject_all: 0, custom: 0, withdraw: 1, total: 1 },
    ]);
    expect(s.byLocale.map((l) => [l.locale, l.total])).toEqual([["en", 7], ["hi", 3]]);
    expect(s.gpc).toEqual({ total: 10, withGpc: 3, share: 0.3 });
    expect(foldConsentStats([], { from: new Date(0), to: new Date(1) }).gpc.share).toBe(0);
  });
  it("queries the table for a range and policy version, and validates the range", async () => {
    const id = cid();
    const from = new Date(Date.now() - 3_600_000);
    await recordCookieConsent({ ...base(id), at: 1_790_300_000, gpc: true, locale: "hi" });
    await recordCookieConsent({ ...base(id), at: 1_790_300_001, action: "withdraw", analytics: false, locale: "hi" });
    const s = await cookieConsentStats({ from, policyVersion: 1 });
    expect(s.total).toBeGreaterThanOrEqual(2);
    expect(s.byLocale.find((l) => l.locale === "hi")?.total).toBeGreaterThanOrEqual(2);
    expect(s.gpc.withGpc).toBeGreaterThanOrEqual(1);
    expect((await cookieConsentStats({ from, policyVersion: 424242 })).total).toBe(0);
    await expect(cookieConsentStats({ from: new Date(), to: new Date(Date.now() - 1000) })).rejects.toMatchObject({ code: "validation" });
    await expect(cookieConsentStats({ from: new Date(0), to: new Date() })).rejects.toMatchObject({ code: "validation" });
  });
});

describe("erasure", () => {
  it("detaches receipts from the person and keeps the anonymous proof", async () => {
    const p = await prisma.person.create({ data: { email: `er-${tag}@example.test` } });
    personIds.push(p.id);
    const id = cid();
    await recordCookieConsent({ ...base(id), at: 1_790_400_000 }, { personId: p.id, registryHash: "c".repeat(64) });
    expect(await anonymizeCookieConsentReceipts(p.id)).toBe(1);
    expect(await anonymizeCookieConsentReceipts(p.id)).toBe(0); // idempotent
    expect(await anonymizeCookieConsentReceipts("not-a-uuid")).toBe(0);
    expect((await listCookieConsentReceipts(id))[0]).toMatchObject({ personId: null, analytics: true, registryHash: "c".repeat(64) });
  });
});

describe("functional (preferences & personalisation) choice", () => {
  const id = cid;
  it("defaults to off for a receipt that omits it (an older queued browser build)", async () => {
    const c = id();
    await recordCookieConsent({ ...base(c), at: 1_790_000_001 });
    expect((await listCookieConsentReceipts(c))[0]).toMatchObject({ functional: false });
  });
  it("is stored independently of analytics and marketing, and reject_all must not carry it", async () => {
    const ok = { ...base(id()), at: 1_790_000_002 };
    await recordCookieConsent({ ...ok, analytics: false, marketing: false, functional: true, gpc: true });
    expect((await listCookieConsentReceipts(ok.consentId))[0]).toMatchObject({ analytics: false, marketing: false, functional: true, gpc: true });
    expect(cookieConsentSchema.safeParse({ ...ok, action: "reject_all", analytics: false, marketing: false, functional: true }).success).toBe(false);
    expect(cookieConsentSchema.safeParse({ ...ok, action: "reject_all", analytics: false, marketing: false, functional: false }).success).toBe(true);
  });
  it("counts grants per category in the stats", () => {
    const s = foldConsentStats([{ day: "2026-10-01", locale: "en", action: "custom", gpc: false, n: 4, analytics: 1, marketing: 2, functional: 3 }], { from: new Date(0), to: new Date(1) });
    expect(s.granted).toEqual({ analytics: 1, marketing: 2, functional: 3 });
  });
  it("cookieConsentStats aggregates the grant counts from the table", async () => {
    const c = id();
    await recordCookieConsent({ ...base(c), functional: true, at: 1_790_000_003 });
    const s = await cookieConsentStats({ from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000) });
    expect(s.granted.functional).toBeGreaterThanOrEqual(1);
  });
});

describe("app column (receipts from more than one app)", () => {
  async function recordAs(consentId: string, ctx: { app?: "web" | "seller" | "studio" | "admin" }) {
    await recordCookieConsent({ ...base(consentId), at: 1_790_200_000 }, ctx);
    return listCookieConsentReceipts(consentId);
  }
  it("records the app the notice was shown in (default web), falls back to web for an unknown app, and filters the staff search by it", async () => {
    const web = cid();
    const seller = cid();
    const odd = cid();
    expect((await recordAs(web, {}))[0]!.app).toBe("web");
    expect((await recordAs(seller, { app: "seller" }))[0]!.app).toBe("seller");
    expect((await recordAs(odd, { app: "nope" as never }))[0]!.app).toBe("web");
    expect((await searchCookieConsentReceipts({ consentId: seller, app: "seller" })).items).toHaveLength(1);
    expect((await searchCookieConsentReceipts({ consentId: seller, app: "web" })).items).toHaveLength(0);
  });
  it("never takes the app from the browser: it is not part of the strict receipt body", async () => {
    await expect(recordCookieConsent({ ...base(cid()), app: "seller" } as never)).rejects.toMatchObject({ code: "validation" });
  });
});
