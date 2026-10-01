import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { cookieConsentSchema, listCookieConsentReceipts, purgeCookieConsentReceipts, recordCookieConsent, RETENTION_POLICIES, runRetention, windowDays } from "../src";

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
    expect(cols.sort()).toEqual(["action", "analytics", "consent_id", "created_at", "gpc", "id", "locale", "marketing", "person_id", "policy_version"]);
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
    const old = await recordCookieConsent(base(oldId));
    await recordCookieConsent(base(freshId));
    const backdated = new Date(Date.now() - 1100 * 86_400_000);
    await prisma.cookieConsentReceipt.update({ where: { id: old.id }, data: { createdAt: backdated } });
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
