// Trust worker handlers, decay job and MFA edge cases.
import { randomUUID } from "node:crypto";
import { redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createBusiness, worker } from "../src";
import { recomputeTrust, runTrustDecay, trustHandlers } from "../src/trust-worker";
import { computeTrustScore, emptySignals } from "../src/trust";
import { beginMfaEnrollment, confirmMfaEnrollment, disableMfa, isMfaEnabled, mfaStatus, regenerateRecoveryCodes, verifyMfa, RECOVERY_CODE_COUNT } from "../src/mfa";
import { base32Decode, totp } from "../src/totp";
import { sha256 } from "../src/tokens";

const bizIds: string[] = [];
const people: string[] = [];
const evIds: number[] = [];
let evSeq = Math.floor(Math.random() * 1e9) * 100;
const delKeys = async (pattern: string) => { const k = await redis.keys(pattern); if (k.length) await redis.del(...k); };
afterAll(async () => {
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: [...bizIds, ...people] } } });
  await prisma.businessMember.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.personMfa.deleteMany({ where: { personId: { in: people } } });
  await prisma.person.deleteMany({ where: { id: { in: people } } });
  if (bizIds.length) await redis.del(...bizIds.map((b) => `trust:${b}`));
  if (evIds.length) await redis.del(...evIds.map((e) => `trust:ev:${e}`));
  await delKeys("rl:mfa:verify:*");
});
afterEach(() => vi.restoreAllMocks());

async function seller() {
  const p = await prisma.person.create({ data: { email: `tw-${randomUUID()}@example.test` } });
  people.push(p.id);
  const { businessId } = await createBusiness(p.id, { name: "Trust Co", isSeller: true });
  bizIds.push(businessId);
  await redis.del(`trust:${businessId}`);
  return businessId;
}
const ev = (type: string, payload: object) => {
  const id = ++evSeq;
  evIds.push(id);
  return { id, type, version: 1, aggregateType: "X", aggregateId: "x", occurredAt: new Date().toISOString(), payload } as never;
};
const counters = (b: string) => redis.hgetall(`trust:${b}`);
const score = async (b: string) => (await prisma.business.findUniqueOrThrow({ where: { id: b } })).trustScore;

describe("trust handlers", () => {
  it("LeadAccepted within the 2h SLA counts as fast, later as slow (boundary inclusive)", async () => {
    const b = await seller();
    await trustHandlers.LeadAccepted!(ev("LeadAccepted", { sellerBusinessId: b, responseMs: 2 * 3600_000 }));
    await trustHandlers.LeadAccepted!(ev("LeadAccepted", { sellerBusinessId: b, responseMs: 2 * 3600_000 + 1 }));
    expect(await counters(b)).toMatchObject({ acceptedFast: "1", acceptedSlow: "1" });
  });
  it("declines, expiries and moderation rejections bump their counters and move the persisted score", async () => {
    const b = await seller();
    await recomputeTrust(b);
    const s0 = await score(b);
    await trustHandlers.LeadDeclined!(ev("LeadDeclined", { sellerBusinessId: b }));
    await trustHandlers.LeadExpired!(ev("LeadExpired", { sellerBusinessId: b }));
    await trustHandlers.ListingModerated!(ev("ListingModerated", { sellerBusinessId: b, status: "rejected" }));
    await trustHandlers.ListingModerated!(ev("ListingModerated", { sellerBusinessId: b, status: "approved" })); // ignored
    expect(await counters(b)).toMatchObject({ declined: "1", expired: "1", modRejected: "1" });
    expect(await score(b)).toBeLessThan(s0);
  });
  it("is idempotent per event id, but different events with the same payload both count", async () => {
    const b = await seller();
    const e = ev("LeadExpired", { sellerBusinessId: b });
    await trustHandlers.LeadExpired!(e);
    await trustHandlers.LeadExpired!(e);
    await trustHandlers.LeadExpired!(ev("LeadExpired", { sellerBusinessId: b }));
    expect((await counters(b)).expired).toBe("2");
  });
  it("regression: a transient recompute failure after the counters were bumped must not double count on redelivery", async () => {
    const b = await seller();
    const e = ev("LeadDeclined", { sellerBusinessId: b });
    vi.spyOn(prisma.business, "findUnique").mockRejectedValueOnce(new Error("db blip"));
    await expect(trustHandlers.LeadDeclined!(e)).rejects.toThrow("db blip");
    await trustHandlers.LeadDeclined!(e); // redelivery
    expect((await counters(b)).declined).toBe("1");
  });
  it("releases the dedupe marker when the counters could not be written so the redelivery is retried", async () => {
    const b = await seller();
    const e = ev("LeadDeclined", { sellerBusinessId: b });
    vi.spyOn(redis, "pipeline").mockImplementationOnce(() => { throw new Error("redis blip"); });
    await expect(trustHandlers.LeadDeclined!(e)).rejects.toThrow("redis blip");
    expect(await redis.exists(`trust:ev:${(e as { id: number }).id}`)).toBe(0);
    await trustHandlers.LeadDeclined!(e);
    expect((await counters(b)).declined).toBe("1");
  });
  it("BusinessVerified recomputes (once per event id) and unknown businesses are ignored", async () => {
    const b = await seller();
    await prisma.business.update({ where: { id: b }, data: { verificationTier: 1 } });
    const e = ev("BusinessVerified", { businessId: b });
    await trustHandlers.BusinessVerified!(e);
    const s = await score(b);
    expect(s).toBe(computeTrustScore({ ...emptySignals(1) }).score);
    await trustHandlers.BusinessVerified!(e);
    await trustHandlers.BusinessVerified!(ev("BusinessVerified", { businessId: randomUUID() }));
    expect(await recomputeTrust(randomUUID())).toBeNull();
  });
});

describe("recomputeTrust", () => {
  it("persists + emits only when the score/badge changed, and reflects tier and inactivity", async () => {
    const b = await seller();
    await prisma.business.update({ where: { id: b }, data: { verificationTier: 1, trustScore: 0, badgeActive: false } });
    const first = await recomputeTrust(b);
    expect(first).toMatchObject({ changed: true });
    const expected = computeTrustScore(emptySignals(1));
    expect(first!.score).toBe(expected.score);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: b } })).badgeActive).toBe(expected.badgeActive);
    expect(await recomputeTrust(b)).toEqual({ changed: false, score: expected.score });
    expect(await prisma.domainEvent.count({ where: { aggregateId: b, type: "TrustScoreChanged" } })).toBe(1);
    // 100 days of inactivity (lastActivityAt in the past) decays the score
    await redis.hset(`trust:${b}`, "lastActivityAt", Date.now() - 100 * 86_400_000);
    const decayed = await recomputeTrust(b);
    expect(decayed!.changed).toBe(true);
    expect(decayed!.score).toBeLessThan(expected.score);
    // tolerant of garbage counters
    await redis.hset(`trust:${b}`, { expired: "not-a-number", acceptedFast: "-", lastActivityAt: "x" });
    await expect(recomputeTrust(b)).resolves.toMatchObject({ score: expect.any(Number) });
  });
  it("runTrustDecay pages over sellers and recomputes their scores", async () => {
    const b = await seller();
    await prisma.business.update({ where: { id: b }, data: { trustScore: 3 } });
    // The count is global (other test files may run a decay pass in parallel and fix this seller first), so assert
    // on this seller's outcome rather than on how many rows this particular run changed.
    expect(await runTrustDecay()).toBeGreaterThanOrEqual(0);
    expect(await score(b)).not.toBe(3);
    expect(await recomputeTrust(b)).toMatchObject({ changed: false });
  });
  it("returns null when the business is erased between the read and the write", async () => {
    const b = await seller();
    const row = await prisma.business.findUniqueOrThrow({ where: { id: b } });
    const ghost = randomUUID();
    const spy = vi.spyOn(prisma.business, "findUnique").mockResolvedValueOnce({ ...row, id: ghost, trustScore: 3 } as never);
    try {
      expect(await recomputeTrust(ghost)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
  it("module worker registers the handlers and the daily trust-decay + gst-recheck jobs", async () => {
    expect(worker.name).toBe("identity");
    expect(Object.keys(worker.handlers ?? {}).sort()).toEqual(["BusinessVerified", "DisputeResolved", "LeadAccepted", "LeadDeclined", "LeadExpired", "LeadRefunded", "ListingModerated", "OfferHonourDecided"]);
    const jobs = worker.jobs ?? [];
    expect(jobs.map((j) => j.name).sort()).toEqual(["identity.audit-expiry", "identity.gst-recheck", "identity.trust-decay"]);
    for (const j of jobs) expect(j.everyMs).toBe(86_400_000);
    await jobs.find((j) => j.name === "identity.trust-decay")!.run();
  });
});

describe("mfa edge cases", () => {
  async function newPerson() {
    const p = await prisma.person.create({ data: { email: `mfa2-${randomUUID()}@example.test` }, select: { id: true } });
    people.push(p.id);
    return p.id;
  }
  const secretOf = (uri: string) => base32Decode(new URL(uri).searchParams.get("secret")!);
  async function enrolled() {
    const id = await newPerson();
    const { otpauthUri } = await beginMfaEnrollment(id, "a@example.test");
    const secret = secretOf(otpauthUri);
    const { recoveryCodes } = await confirmMfaEnrollment(id, totp(secret, Date.now()));
    return { id, secret, recoveryCodes };
  }

  it("re-showing enrollment before confirmation returns the SAME secret; once enabled it refuses to restart", async () => {
    const id = await newPerson();
    const a = await beginMfaEnrollment(id, "a@example.test");
    const b = await beginMfaEnrollment(id, "a@example.test");
    expect(new URL(b.otpauthUri).searchParams.get("secret")).toBe(new URL(a.otpauthUri).searchParams.get("secret"));
    expect(a.manualKey).toBe(b.manualKey);
    await confirmMfaEnrollment(id, totp(secretOf(a.otpauthUri), Date.now()));
    await expect(beginMfaEnrollment(id, "a@example.test")).rejects.toMatchObject({ code: "conflict" });
  });
  it("issuer defaults to Cnote and comes from MFA_ISSUER when set", async () => {
    vi.stubEnv("MFA_ISSUER", "");
    expect(new URL((await beginMfaEnrollment(await newPerson(), "x@example.test")).otpauthUri).searchParams.get("issuer")).toBe("Cnote");
    vi.stubEnv("MFA_ISSUER", "Acme Admin");
    const { otpauthUri } = await beginMfaEnrollment(await newPerson(), "x@example.test");
    expect(new URL(otpauthUri).searchParams.get("issuer")).toBe("Acme Admin");
    vi.unstubAllEnvs();
  });
  it("confirming without starting, or twice, is rejected; wrong enrollment code leaves MFA disabled", async () => {
    const id = await newPerson();
    await expect(confirmMfaEnrollment(id, "123456")).rejects.toMatchObject({ code: "validation" });
    await beginMfaEnrollment(id, "a@example.test");
    await expect(confirmMfaEnrollment(id, "000000")).rejects.toMatchObject({ code: "unauthenticated" });
    expect(await isMfaEnabled(id)).toBe(false);
    const e = await enrolled();
    await expect(confirmMfaEnrollment(e.id, totp(e.secret, Date.now()))).rejects.toMatchObject({ code: "validation" });
  });
  it("verifyMfa fails closed when MFA is not enabled (never-enrolled or mid-enrollment)", async () => {
    const id = await newPerson();
    await expect(verifyMfa(id, "123456")).rejects.toMatchObject({ code: "unauthenticated" });
    const { otpauthUri } = await beginMfaEnrollment(id, "a@example.test");
    await expect(verifyMfa(id, totp(secretOf(otpauthUri), Date.now()))).rejects.toMatchObject({ code: "unauthenticated" });
  });
  it("accepts spaced TOTP input, rejects wrong shapes, returns method + remaining recovery codes", async () => {
    const e = await enrolled();
    expect(e.recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(e.recoveryCodes).size).toBe(RECOVERY_CODE_COUNT);
    for (const c of e.recoveryCodes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    // the enrollment step is already consumed: use the next window's code
    const next = totp(e.secret, Date.now() + 30_000);
    const code = `${next.slice(0, 3)} ${next.slice(3)}`;
    expect(await verifyMfa(e.id, ` ${code} `)).toEqual({ method: "totp", recoveryCodesLeft: RECOVERY_CODE_COUNT });
    for (const bad of ["", "12345", "1234567", "abcdef", "zzzzz-zzzzz-z"]) await expect(verifyMfa(e.id, bad)).rejects.toMatchObject({ code: "unauthenticated" });
  });
  it("recovery codes: case/dash-insensitive, single use, count decrements, only hashes stored", async () => {
    const e = await enrolled();
    const row = await prisma.personMfa.findUniqueOrThrow({ where: { personId: e.id } });
    expect(row.recoveryCodeHashes).toContain(sha256(e.recoveryCodes[0]!.replace("-", "")));
    expect(row.recoveryCodeHashes.join()).not.toContain(e.recoveryCodes[0]!);
    expect(await verifyMfa(e.id, e.recoveryCodes[0]!.toUpperCase().replace("-", " "))).toEqual({ method: "recovery", recoveryCodesLeft: RECOVERY_CODE_COUNT - 1 });
    await expect(verifyMfa(e.id, e.recoveryCodes[0]!)).rejects.toMatchObject({ code: "unauthenticated" });
    expect((await mfaStatus(e.id)).recoveryCodesLeft).toBe(RECOVERY_CODE_COUNT - 1);
    // a valid code for ANOTHER person never works
    const other = await enrolled();
    await expect(verifyMfa(other.id, e.recoveryCodes[1]!)).rejects.toMatchObject({ code: "unauthenticated" });
  });
  it("TOTP replay: the same step cannot be used twice, even concurrently; an older step after a newer one is rejected", async () => {
    const e = await enrolled();
    const t1 = totp(e.secret, Date.now() + 30_000);
    const res = await Promise.allSettled([verifyMfa(e.id, t1), verifyMfa(e.id, t1), verifyMfa(e.id, t1)]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(verifyMfa(e.id, totp(e.secret, Date.now() - 30_000))).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(verifyMfa(e.id, totp(e.secret, Date.now() + 5 * 30_000))).rejects.toMatchObject({ code: "unauthenticated" });
  });
  it("disable/regenerate need a valid code; regenerate invalidates the old set; disable removes the row", async () => {
    const e = await enrolled();
    await expect(disableMfa(e.id, "000000")).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(regenerateRecoveryCodes(e.id, "nope")).rejects.toMatchObject({ code: "unauthenticated" });
    const fresh = await regenerateRecoveryCodes(e.id, e.recoveryCodes[0]!);
    expect(fresh).toHaveLength(RECOVERY_CODE_COUNT);
    await expect(verifyMfa(e.id, e.recoveryCodes[1]!)).rejects.toMatchObject({ code: "unauthenticated" });
    await disableMfa(e.id, fresh[0]!);
    expect(await mfaStatus(e.id)).toEqual({ enabled: false, enrolling: false, recoveryCodesLeft: 0 });
    expect(await prisma.personMfa.count({ where: { personId: e.id } })).toBe(0);
    await expect(verifyMfa(e.id, fresh[1]!)).rejects.toMatchObject({ code: "unauthenticated" });
  });
  it("attempt rate limit: 8 per 5 min per person then rate_limited (also for enrollment confirmation); window resets", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2038-01-01T00:00:00Z"));
    const e = await enrolled();
    for (let i = 0; i < 7; i++) await expect(verifyMfa(e.id, "000000")).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(verifyMfa(e.id, "000000")).rejects.toMatchObject({ code: "rate_limited" });
    await expect(confirmMfaEnrollment(e.id, "000000")).rejects.toMatchObject({ code: "rate_limited" });
    vi.setSystemTime(new Date("2038-01-01T00:05:00Z"));
    await expect(verifyMfa(e.id, "000000")).rejects.toMatchObject({ code: "unauthenticated" });
    vi.useRealTimers();
  });
  it("the TOTP secret is bound to the person (ciphertext copied to another person cannot be decrypted)", async () => {
    const a = await enrolled();
    const b = await enrolled();
    const rowA = await prisma.personMfa.findUniqueOrThrow({ where: { personId: a.id } });
    await prisma.personMfa.update({ where: { personId: b.id }, data: { totpSecretEnc: rowA.totpSecretEnc } });
    await expect(verifyMfa(b.id, totp(a.secret, Date.now() + 60_000))).rejects.toThrow();
  });
});

describe("runTrustDecay pagination", () => {
  it("keeps going when the previous page's last row is deleted mid-run (keyset, not row cursor)", async () => {
    const ids = [await seller(), await seller(), await seller()].sort();
    for (const id of ids) await prisma.business.update({ where: { id }, data: { trustScore: 3 } });
    const original = prisma.business.findMany.bind(prisma.business);
    let pages = 0;
    const spy = vi.spyOn(prisma.business, "findMany").mockImplementation((async (args: Parameters<typeof original>[0]) => {
      const where = { ...(args?.where ?? {}), id: { ...((args?.where?.id as object) ?? {}), in: ids } };
      const page = await original({ ...args, where } as never);
      // After the first page, delete the row the next page would have used as a Prisma row cursor.
      if (pages++ === 0 && page[0]) {
        await prisma.businessMember.deleteMany({ where: { businessId: page[0].id } });
        await prisma.business.delete({ where: { id: page[0].id } });
      }
      return page;
    }) as never);
    try {
      await runTrustDecay({ pageSize: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(pages).toBeGreaterThanOrEqual(3);
    for (const id of ids.slice(1)) expect(await score(id)).not.toBe(3);
  });
});
