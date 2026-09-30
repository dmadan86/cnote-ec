// GST verification scoring matrix, verification flows, manual review queue, continuous re-verification, company profile, business/directory APIs.
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  bustSellerCaches, createBusiness, createMockGstnProvider, evaluateGstChecks, getCompanyProfile, getGstEvidence, getPersonBusinesses, getTrustProfiles, gstinCheckChar, isRecheckDue,
  listPendingGstReviews, listSellerIndex, listSellers, listVerificationRecords, panFromGstin, recheckGstStatus, resolveGstReview, runGstRecheck, setGstnProvider,
  setListingHsnSource, updateCompanyProfile, updateProfile, verifyCompanyGst, verifyGstin, GstnProviderError, type GstnRecord,
} from "../src";
import { NAME_PASS, NAME_REVIEW } from "../src/gst/verify";
import { recheckBucket } from "../src/gst/continuous";
import {
  getPersonByEmail, getPersonContact, getPersonSummaries, isBusinessMember, isPersonErased, listBusinessMembers,
} from "../src/directory";
import { setConsent } from "../src/consent";

const L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const rnd = (n: number, set: string) => Array.from({ length: n }, () => set[Math.floor(Math.random() * set.length)]).join("");
function gstin(code = "1", state = "27") {
  const first14 = `${state}${rnd(5, L)}${rnd(4, "0123456789")}${rnd(1, L)}${code}Z`;
  return first14 + gstinCheckChar(first14);
}
const mock = createMockGstnProvider();
const bizIds: string[] = [];
const personIds: string[] = [];
beforeAll(() => setGstnProvider(mock));
afterEach(() => { mock.clearFixtures(); setListingHsnSource(null); vi.restoreAllMocks(); });
afterAll(async () => {
  setGstnProvider(null);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: [...bizIds, ...personIds] } } });
  await prisma.verificationRecord.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.consent.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.businessMember.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

async function seller(name = `Biz ${randomUUID().slice(0, 8)}`, isSeller = true) {
  const person = await prisma.person.create({ data: { email: `gv-${randomUUID()}@example.test`, name: "Owner" } });
  personIds.push(person.id);
  const { businessId } = await createBusiness(person.id, { name, isSeller });
  bizIds.push(businessId);
  return { personId: person.id, businessId, actor: { personId: person.id, businessId }, name };
}
const address = (stateCode = "27") => ({ line1: "12 MIDC Road", city: "Pune", state: "Maharashtra", stateCode, pincode: "411019" });
const profile = (legalName: string, extra: object = {}) => ({ legalName, companyType: "private_limited" as const, registeredAddress: address(), ...extra });
const rec = (o: Partial<GstnRecord> = {}): GstnRecord => ({ legalName: "Sharma Steel Private Limited", state: "Maharashtra", status: "Active", ...o });
const filings = (n: number, filed: number) => Array.from({ length: n }, (_, i) => ({ period: `2026-0${i + 1}`, filed: i < filed }));

describe("evaluateGstChecks matrix", () => {
  const g = gstin();
  const base = { gstin: g, declared: { names: ["Sharma Steel Pvt Ltd"], pan: panFromGstin(g), stateCode: "27" } };
  const result = (o: ReturnType<typeof evaluateGstChecks>, id: string) => o.checks.find((c) => c.id === id)!;

  it("all good => passed, 100", () => {
    const o = evaluateGstChecks({ ...base, record: rec({ filings: filings(6, 6), hsnCodes: ["7208"] }), listingHsns: ["720811"] });
    expect(o).toMatchObject({ decision: "passed", score: 100, reasons: [] });
  });
  it("skips (and excludes from the score) checks with no data", () => {
    const o = evaluateGstChecks({ gstin: g, record: rec(), declared: { names: ["Sharma Steel"], stateCode: "27" } });
    expect(result(o, "pan").result).toBe("skip");
    expect(result(o, "filing").result).toBe("skip");
    expect(result(o, "hsn").result).toBe("skip");
    expect(o.score).toBe(100);
  });
  it.each([[6, 6, "pass"], [6, 5, "pass"], [6, 4, "warn"], [6, 3, "warn"], [6, 2, "fail"], [6, 0, "fail"], [3, 3, "warn"], [1, 1, "fail"]])("filing %i periods / %i filed => %s", (n, f, want) => {
    expect(result(evaluateGstChecks({ ...base, record: rec({ filings: filings(n, f) }) }), "filing").result).toBe(want);
  });
  it("only the most recent 6 filings are considered", () => {
    const old = filings(12, 0).map((f, i) => ({ ...f, filed: i < 6 }));
    expect(result(evaluateGstChecks({ ...base, record: rec({ filings: old }) }), "filing").result).toBe("pass");
  });
  it("name thresholds: >=0.85 pass, >=0.6 warn(review), below fail", () => {
    expect(NAME_PASS).toBe(0.85);
    expect(NAME_REVIEW).toBe(0.6);
    const pass = evaluateGstChecks({ ...base, record: rec() });
    expect(result(pass, "name")).toMatchObject({ result: "pass" });
    const warn = evaluateGstChecks({ ...base, declared: { ...base.declared, names: ["Sharma Steel Traders"] }, record: rec({ legalName: "Sharma Steel Works" }) });
    expect(result(warn, "name").result).toBe("warn");
    expect(warn.decision).toBe("review");
    const fail = evaluateGstChecks({ ...base, declared: { ...base.declared, names: ["Completely Different"] } , record: rec() });
    expect(result(fail, "name").result).toBe("fail");
    expect(fail.decision).toBe("failed");
  });
  it("best match across declared names and both registered names wins", () => {
    const o = evaluateGstChecks({ ...base, declared: { ...base.declared, names: ["Unrelated Co", "Acme Traders"] }, record: rec({ legalName: "Sharma Steel", tradeName: "Acme Traders" }) });
    expect(result(o, "name").result).toBe("pass");
  });
  it("no names on either side => warn (manual look)", () => {
    for (const declared of [{ names: [] as string[] }, { names: [""] }]) expect(result(evaluateGstChecks({ gstin: g, record: rec(), declared }), "name").result).toBe("warn");
    expect(result(evaluateGstChecks({ gstin: g, record: rec({ legalName: "" }), declared: { names: ["X"] } }), "name").result).toBe("warn");
  });
  it("state: missing/different => warn => review; matching => pass", () => {
    expect(result(evaluateGstChecks({ ...base, declared: { ...base.declared, stateCode: null } , record: rec() }), "state").result).toBe("warn");
    const o = evaluateGstChecks({ ...base, declared: { ...base.declared, stateCode: "29" }, record: rec() });
    expect(o.decision).toBe("review");
    expect(o.reasons.join()).toContain("29");
  });
  it("status other than Active always fails, whatever else is perfect", () => {
    for (const status of ["Cancelled", "Suspended", "Inactive"] as const) {
      const o = evaluateGstChecks({ ...base, record: rec({ status, filings: filings(6, 6) }) });
      expect(o.decision).toBe("failed");
      expect(o.reasons[0]).toContain(status.toLowerCase());
    }
  });
  it("PAN mismatch fails; matching passes; undeclared is skipped", () => {
    expect(evaluateGstChecks({ ...base, declared: { ...base.declared, pan: "ZZZZZ9999Z" }, record: rec() }).decision).toBe("failed");
  });
  it("HSN: overlap on 4-digit prefix passes; none => warn but never gates", () => {
    expect(result(evaluateGstChecks({ ...base, record: rec({ hsnCodes: ["72081000"] }), listingHsns: ["7208"] }), "hsn").result).toBe("pass");
    const w = evaluateGstChecks({ ...base, record: rec({ hsnCodes: ["7208"] }), listingHsns: ["9999"] });
    expect(result(w, "hsn").result).toBe("warn");
    expect(w.decision).toBe("passed");
    expect(w.score).toBeLessThan(100);
  });
  it("precedence: failed > review > passed", () => {
    const o = evaluateGstChecks({ ...base, declared: { ...base.declared, stateCode: "29", pan: "ZZZZZ9999Z" }, record: rec() });
    expect(o.decision).toBe("failed");
  });
  it("property: score in 0..100; passed implies status/name/state/pan all pass or skip; non-Active is never passed", () => {
    const arb = fc.record({
      status: fc.constantFrom("Active", "Cancelled", "Suspended", "Inactive"),
      names: fc.array(fc.constantFrom("Sharma Steel Pvt Ltd", "Sharma Steel", "Other Traders", "", "Sharma Steel Works"), { maxLength: 3 }),
      legal: fc.constantFrom("Sharma Steel Private Limited", "Zed Corp", ""),
      state: fc.constantFrom(null, "27", "29"),
      pan: fc.constantFrom(undefined, panFromGstin(g), "AAAAA0000A"),
      nf: fc.integer({ min: 0, max: 8 }),
      nfiled: fc.integer({ min: 0, max: 8 }),
    });
    fc.assert(fc.property(arb, (a) => {
      const o = evaluateGstChecks({ gstin: g, record: rec({ status: a.status as GstnRecord["status"], legalName: a.legal, filings: filings(a.nf, Math.min(a.nf, a.nfiled)) }), declared: { names: a.names, pan: a.pan, stateCode: a.state } });
      expect(o.score).toBeGreaterThanOrEqual(0);
      expect(o.score).toBeLessThanOrEqual(100);
      if (a.status !== "Active") expect(o.decision).toBe("failed");
      if (o.decision === "passed") for (const id of ["status", "name", "state", "pan"]) expect(["pass", "skip"]).toContain(o.checks.find((c) => c.id === id)!.result);
      expect(o.reasons.length).toBe(o.checks.filter((c) => c.result === "warn" || c.result === "fail").length);
    }), { numRuns: 300 });
  });
});

describe("recheck scheduling (property)", () => {
  it("buckets are stable and within 0..29; overdue and never-checked are always due; <30 days never due", () => {
    fc.assert(fc.property(fc.uuid(), fc.integer({ min: 0, max: 200 }), fc.integer({ min: 1_700_000_000_000, max: 1_900_000_000_000 }), (id, ageDays, nowMs) => {
      const b = recheckBucket(id);
      expect(b).toBe(recheckBucket(id));
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(30);
      const now = new Date(nowMs);
      expect(isRecheckDue(id, null, now)).toBe(true);
      const last = new Date(nowMs - ageDays * 86_400_000);
      const due = isRecheckDue(id, last, now);
      if (ageDays < 30) expect(due).toBe(false);
      if (ageDays >= 40) expect(due).toBe(true);
    }), { numRuns: 300 });
  });
  it("in the 30-40 day band exactly the business's bucket day is due, so every business is checked within the band", () => {
    const id = randomUUID();
    const start = Date.UTC(2026, 0, 1);
    const dueDays = Array.from({ length: 10 }, (_, d) => d).filter((d) => isRecheckDue(id, new Date(start), new Date(start + (30 + d) * 86_400_000)));
    for (const d of dueDays) expect(Math.floor((start + (30 + d) * 86_400_000) / 86_400_000) % 30).toBe(recheckBucket(id));
  });
});

describe("verifyCompanyGst flows", () => {
  it("requires a GSTIN and an existing business", async () => {
    const { businessId } = await seller();
    await expect(verifyCompanyGst(businessId)).rejects.toMatchObject({ code: "validation" });
    await expect(verifyCompanyGst(randomUUID(), { gstin: gstin() })).rejects.toMatchObject({ code: "not_found" });
  });
  it("structurally invalid GSTIN => failed + failed record, provider never asked", async () => {
    const { businessId } = await seller();
    const spy = vi.spyOn(mock, "lookup");
    const o = await verifyCompanyGst(businessId, { gstin: "27AAPFU0939F1ZA" });
    expect(o).toMatchObject({ decision: "failed", score: 0 });
    expect(o.reasons[0]).toContain("Invalid GSTIN");
    expect(spy).not.toHaveBeenCalled();
    expect(await prisma.verificationRecord.count({ where: { businessId, status: "failed" } })).toBe(1);
  });
  it("normalises the input GSTIN (case/space)", async () => {
    const { actor, businessId, name } = await seller("Norm Works");
    const g = gstin();
    await updateCompanyProfile(actor, profile(`${name} Pvt Ltd`));
    const o = await verifyCompanyGst(businessId, { gstin: ` ${g.toLowerCase()} ` });
    expect(o.gstin).toBe(g);
    expect(o.provider).toBe("mock");
  });
  it("GSTIN not found in the registry => failed, check time stamped", async () => {
    const { businessId } = await seller();
    const o = await verifyCompanyGst(businessId, { gstin: gstin("N") });
    expect(o.reasons).toEqual(["GSTIN not found in the GST registry."]);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: businessId } })).gstLastCheckedAt).not.toBeNull();
  });
  it("rethrows unexpected (non-provider) errors and hides provider outages behind 'unavailable'", async () => {
    const { businessId } = await seller();
    vi.spyOn(mock, "lookup").mockRejectedValueOnce(new Error("bug"));
    await expect(verifyCompanyGst(businessId, { gstin: gstin() })).rejects.toThrow("bug");
    vi.spyOn(mock, "lookup").mockRejectedValueOnce(new GstnProviderError("circuit_open", "open"));
    const o = await verifyCompanyGst(businessId, { gstin: gstin() });
    expect(o).toMatchObject({ decision: "unavailable", checks: [], record: null });
    expect(o.reasons[0]).toContain("temporarily unavailable");
    expect((await prisma.business.findUniqueOrThrow({ where: { id: businessId } })).verificationTier).toBe(0);
  });
  it("a GSTIN already verified for another business is refused (no tier change, failed record)", async () => {
    const a = await seller("Dup A");
    const b = await seller("Dup B");
    const g = gstin();
    await updateCompanyProfile(a.actor, profile("Dup A Pvt Ltd"));
    await updateCompanyProfile(b.actor, profile("Dup B Pvt Ltd"));
    expect((await verifyCompanyGst(a.businessId, { gstin: g })).decision).toBe("passed");
    const o = await verifyCompanyGst(b.businessId, { gstin: g });
    expect(o.decision).toBe("failed");
    expect(o.reasons).toContain("This GSTIN is already registered to another business.");
    expect((await prisma.business.findUniqueOrThrow({ where: { id: b.businessId } })).verificationTier).toBe(0);
  });
  it("PAN mismatch (declared vs GSTIN) is a hard fail even though the provider says Active", async () => {
    const { actor, businessId } = await seller("Pan Mismatch");
    const g = gstin();
    await updateCompanyProfile(actor, profile("Pan Mismatch Pvt Ltd", { pan: "AAAAA0000A" }));
    const o = await verifyCompanyGst(businessId, { gstin: g });
    expect(o.decision).toBe("failed");
    expect(o.checks.find((c) => c.id === "pan")?.result).toBe("fail");
  });
  it("review: repeated verification updates the single pending record instead of stacking new ones", async () => {
    const { actor, businessId } = await seller("Review Tools");
    const g = gstin();
    mock.setFixture(g, rec({ legalName: "Review Tool Works Traders" }));
    await updateCompanyProfile(actor, profile("Review Tools Enterprises"));
    expect((await verifyCompanyGst(businessId, { gstin: g })).decision).toBe("review");
    expect((await verifyCompanyGst(businessId, { gstin: g })).decision).toBe("review");
    expect(await prisma.verificationRecord.count({ where: { businessId, status: "pending" } })).toBe(1);
    expect((await listPendingGstReviews(200)).filter((r) => r.businessId === businessId)).toHaveLength(1);
  });
  it("HSN hint uses the registered source; a throwing source is ignored", async () => {
    const { actor, businessId } = await seller("Hsn Works");
    const g = gstin();
    mock.setFixture(g, rec({ legalName: "Hsn Works Private Limited", hsnCodes: ["7208"] }));
    await updateCompanyProfile(actor, profile("Hsn Works Private Limited"));
    setListingHsnSource(async () => { throw new Error("catalogue down"); });
    const o = await verifyCompanyGst(businessId, { gstin: g });
    expect(o.decision).toBe("passed");
    expect(o.checks.find((c) => c.id === "hsn")?.result).toBe("skip");
    setListingHsnSource(async () => ["720811"]);
    const o2 = await verifyCompanyGst(businessId, { gstin: g });
    expect(o2.checks.find((c) => c.id === "hsn")?.result).toBe("pass");
  });
  it("tier never decreases on a passing re-verification", async () => {
    const { actor, businessId } = await seller("Tier Keep");
    const g = gstin();
    await updateCompanyProfile(actor, profile("Tier Keep Pvt Ltd"));
    await prisma.business.update({ where: { id: businessId }, data: { verificationTier: 2 } });
    const o = await verifyCompanyGst(businessId, { gstin: g });
    expect(o.tier).toBe(2);
  });
  it("evidence history: newest first with checks, snapshot and manual review", async () => {
    const { actor, businessId } = await seller("Evidence Co");
    const g = gstin();
    await updateCompanyProfile(actor, profile("Evidence Co Pvt Ltd"));
    await verifyCompanyGst(businessId, { gstin: "27AAPFU0939F1ZA" });
    await verifyCompanyGst(businessId, { gstin: g });
    await recheckGstStatus(businessId);
    const ev = await getGstEvidence(businessId);
    expect(ev).toHaveLength(3);
    expect(ev[0]).toMatchObject({ recheck: true, status: "passed", gstin: g });
    expect(ev[1]).toMatchObject({ recheck: false, decision: "passed", provider: "mock" });
    expect(ev[1]!.checks.length).toBeGreaterThan(3);
    expect(ev[1]!.snapshot?.status).toBe("Active");
    expect(ev[2]).toMatchObject({ status: "failed", manualReview: null });
    expect(await getGstEvidence(businessId, 1)).toHaveLength(1);
    expect(await getGstEvidence(businessId, 0)).toHaveLength(1); // clamped to >=1
  });
});

describe("manual GST review queue", () => {
  async function pending() {
    const s = await seller("Gamma Tools");
    const g = gstin();
    mock.setFixture(g, rec({ legalName: "Gamma Tool Works Traders" }));
    await updateCompanyProfile(s.actor, profile("Gamma Tools Enterprises"));
    expect((await verifyCompanyGst(s.businessId, { gstin: g })).decision).toBe("review");
    const item = (await listPendingGstReviews(200)).find((r) => r.businessId === s.businessId)!;
    return { ...s, g, item };
  }
  it("lists reasons and score, oldest first, and clamps the limit", async () => {
    const { item } = await pending();
    expect(item.reasons.length).toBeGreaterThan(0);
    expect(item.score).toEqual(expect.any(Number));
    expect(await listPendingGstReviews(0)).toHaveLength(1);
    const all = await listPendingGstReviews(9999);
    const times = all.map((r) => r.createdAt);
    expect([...times].sort()).toEqual(times);
  });
  it("reject => failed, tier untouched, audit trail (staff, note) kept, cannot be resolved twice", async () => {
    const { item, businessId } = await pending();
    const staff = randomUUID();
    expect(await resolveGstReview(item.id, "rejected", staff, "docs mismatch")).toEqual({ status: "failed" });
    const rec2 = await prisma.verificationRecord.findUniqueOrThrow({ where: { id: item.id } });
    expect(rec2.status).toBe("failed");
    expect((rec2.details as any).manualReview).toMatchObject({ decision: "rejected", staffId: staff, note: "docs mismatch" });
    expect((await prisma.business.findUniqueOrThrow({ where: { id: businessId } })).verificationTier).toBe(0);
    await expect(resolveGstReview(item.id, "approved", staff)).rejects.toMatchObject({ code: "conflict" });
  });
  it("concurrent staff decisions: exactly one wins", async () => {
    const { item, businessId } = await pending();
    const res = await Promise.allSettled([resolveGstReview(item.id, "approved", randomUUID()), resolveGstReview(item.id, "rejected", randomUUID()), resolveGstReview(item.id, "approved", randomUUID())]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of res) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "conflict" });
    void businessId;
  });
  it("not found / wrong kind / approval without GSTIN / GSTIN taken by another business", async () => {
    await expect(resolveGstReview(randomUUID(), "approved", "s")).rejects.toMatchObject({ code: "not_found" });
    const s = await seller();
    const udyam = await prisma.verificationRecord.create({ data: { businessId: s.businessId, tier: 1, kind: "udyam", status: "pending", provider: "x", details: {} } });
    await expect(resolveGstReview(udyam.id, "approved", "s")).rejects.toMatchObject({ code: "not_found" });
    const noG = await prisma.verificationRecord.create({ data: { businessId: s.businessId, tier: 1, kind: "gstin", status: "pending", provider: "mock", details: {} } });
    await expect(resolveGstReview(noG.id, "approved", "s")).rejects.toMatchObject({ code: "validation" });
    const p = await pending();
    const other = await seller();
    await prisma.business.update({ where: { id: other.businessId }, data: { gstin: p.g } });
    await expect(resolveGstReview(p.item.id, "approved", "s")).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("already registered") });
    // failed approvals release the claim: staff can still decide (reject) afterwards
    expect(await resolveGstReview(p.item.id, "rejected", "s", "GSTIN belongs to another business")).toEqual({ status: "failed" });
    expect(await resolveGstReview(noG.id, "rejected", "s")).toEqual({ status: "failed" });
  });
  it("approval passes the business to tier 1, snapshot status, emits BusinessVerified once", async () => {
    const { item, businessId } = await pending();
    expect(await resolveGstReview(item.id, "approved", randomUUID(), "looks fine")).toEqual({ status: "passed", tier: 1 });
    expect(await prisma.domainEvent.count({ where: { aggregateId: businessId, type: "BusinessVerified" } })).toBe(1);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: businessId } })).gstStatus).toBe("Active");
  });
});

describe("continuous re-verification", () => {
  async function verified(name = "Cont Co") {
    const s = await seller(name);
    const g = gstin();
    await updateCompanyProfile(s.actor, profile(`${name} Pvt Ltd`));
    expect((await verifyCompanyGst(s.businessId, { gstin: g })).decision).toBe("passed");
    return { ...s, g };
  }
  it("returns null without a GSTIN; provider outage keeps everything as is and is retried (still due)", async () => {
    const s = await seller();
    expect(await recheckGstStatus(s.businessId)).toBeNull();
    expect(await recheckGstStatus(randomUUID())).toBeNull();
    const v = await verified();
    vi.spyOn(mock, "lookup").mockRejectedValueOnce(new GstnProviderError("timeout", "t"));
    expect(await recheckGstStatus(v.businessId)).toEqual({ businessId: v.businessId, status: "unavailable", revoked: false });
    vi.spyOn(mock, "lookup").mockRejectedValueOnce(new Error("bug"));
    await expect(recheckGstStatus(v.businessId)).rejects.toThrow("bug");
    expect((await prisma.business.findUniqueOrThrow({ where: { id: v.businessId } })).verificationTier).toBe(1);
  });
  it("Suspended/Cancelled/not-found revoke T1, clear gstVerifiedAt, drop the badge, emit gstin_revoked + TrustScoreChanged", async () => {
    for (const status of ["Suspended", "Cancelled", "not_found"] as const) {
      const v = await verified(`Rev ${status}`);
      await prisma.business.update({ where: { id: v.businessId }, data: { trustScore: 90, badgeActive: true } });
      mock.setFixture(v.g, status === "not_found" ? null : rec({ legalName: `Rev ${status} Pvt Ltd`, status }));
      const r = await recheckGstStatus(v.businessId);
      expect(r).toMatchObject({ status, revoked: true });
      const b = await prisma.business.findUniqueOrThrow({ where: { id: v.businessId } });
      expect(b).toMatchObject({ verificationTier: 0, badgeActive: false, gstVerifiedAt: null, gstStatus: status === "not_found" ? "Inactive" : status });
      const evs = await prisma.domainEvent.findMany({ where: { aggregateId: v.businessId }, select: { type: true, payload: true } });
      expect(evs.some((e) => e.type === "BusinessVerified" && (e.payload as any).kind === "gstin_revoked" && (e.payload as any).tier === 0)).toBe(true);
      expect(evs.some((e) => e.type === "TrustScoreChanged")).toBe(true);
      expect(await prisma.verificationRecord.count({ where: { businessId: v.businessId, status: "failed" } })).toBe(1);
    }
  });
  it("an already-unverified business with a bad GSTIN is not 'revoked' again", async () => {
    const s = await seller();
    const g = gstin("C");
    await prisma.business.update({ where: { id: s.businessId }, data: { gstin: g } });
    expect(await recheckGstStatus(s.businessId)).toMatchObject({ status: "Cancelled", revoked: false });
    expect(await prisma.domainEvent.count({ where: { aggregateId: s.businessId, type: "BusinessVerified" } })).toBe(0);
  });
  it("Active keeps the tier and records a passed recheck", async () => {
    const v = await verified();
    const r = await recheckGstStatus(v.businessId, new Date("2030-01-01T00:00:00Z"));
    expect(r).toMatchObject({ status: "Active", revoked: false });
    expect((await prisma.business.findUniqueOrThrow({ where: { id: v.businessId } })).gstLastCheckedAt?.toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });
  it("runGstRecheck: checks only due businesses, respects maxPerRun, counts revocations, skips unavailable", async () => {
    const due = await verified("Due Co");
    const fresh = await verified("Fresh Co");
    await prisma.business.update({ where: { id: due.businessId }, data: { gstLastCheckedAt: new Date("2020-01-01") } });
    await prisma.business.update({ where: { id: fresh.businessId }, data: { gstLastCheckedAt: new Date() } });
    const spy = vi.spyOn(mock, "lookup");
    mock.setFixture(due.g, rec({ status: "Cancelled" }));
    const res = await runGstRecheck(new Date());
    expect(res.checked).toBeGreaterThanOrEqual(1);
    expect(res.revoked).toBeGreaterThanOrEqual(1);
    expect(spy.mock.calls.some(([g]) => g === due.g)).toBe(true);
    expect(spy.mock.calls.some(([g]) => g === fresh.g)).toBe(false);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: due.businessId } })).verificationTier).toBe(0);
    expect(await runGstRecheck(new Date(), 0)).toEqual({ checked: 0, revoked: 0 });
    // provider outage: not counted as checked
    const again = await verified("Again Co");
    await prisma.business.update({ where: { id: again.businessId }, data: { gstLastCheckedAt: new Date("2020-01-01") } });
    spy.mockRejectedValue(new GstnProviderError("unavailable", "down"));
    expect(await runGstRecheck(new Date())).toEqual({ checked: 0, revoked: 0 });
  });
});

describe("company profile", () => {
  it("only owners may edit; validation reports the first problem", async () => {
    const s = await seller();
    const staff = await prisma.person.create({ data: { email: `st-${randomUUID()}@example.test` } });
    personIds.push(staff.id);
    await prisma.businessMember.create({ data: { businessId: s.businessId, personId: staff.id, role: "staff" } });
    await expect(updateCompanyProfile({ personId: staff.id, businessId: s.businessId }, profile("Some Name Pvt Ltd"))).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateCompanyProfile({ personId: randomUUID(), businessId: s.businessId }, profile("Some Name Pvt Ltd"))).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateCompanyProfile(s.actor, { ...profile("X"), legalName: "X" })).rejects.toMatchObject({ code: "validation" });
    await expect(updateCompanyProfile(s.actor, profile("Some Name", { gstin: "BAD" }))).rejects.toThrow(/Invalid GSTIN/);
    await expect(updateCompanyProfile(s.actor, profile("Some Name", { companyType: "proprietorship", cin: "U12345MH2019PTC123456" }))).rejects.toThrow(/companies only/);
    await expect(updateCompanyProfile(s.actor, profile("Some Name", { companyType: "llp", cin: "U12345MH2019PTC123456" }))).rejects.toThrow(/LLPIN/);
    await expect(updateCompanyProfile(s.actor, profile("Some Name", { website: "ftp://x.com" }))).rejects.toThrow();
    await expect(updateCompanyProfile(s.actor, { ...profile("Some Name"), registeredAddress: { ...address(), stateCode: "99" } })).rejects.toThrow(/state/i);
    await expect(updateCompanyProfile(s.actor, { ...profile("Some Name"), registeredAddress: { ...address(), pincode: "012345" } })).rejects.toThrow(/pincode/);
  });
  it("normalises blanks/case, syncs listing location, masks the PAN, and checks PAN against an already-stored GSTIN", async () => {
    const s = await seller("Profile Co");
    const g = gstin();
    const v = await updateCompanyProfile(s.actor, profile("Profile Co Pvt Ltd", { tradeName: "  ", cin: "", pan: panFromGstin(g).toLowerCase(), website: "https://profile.example" }));
    expect(v).toMatchObject({ legalName: "Profile Co Pvt Ltd", tradeName: null, cin: null, panMasked: `XXXXX${panFromGstin(g).slice(5)}`, website: "https://profile.example" });
    const b = await prisma.business.findUniqueOrThrow({ where: { id: s.businessId } });
    expect(b).toMatchObject({ city: "Pune", state: "Maharashtra", pincode: "411019" });
    await prisma.business.update({ where: { id: s.businessId }, data: { gstin: g } });
    await expect(updateCompanyProfile(s.actor, profile("Profile Co Pvt Ltd", { pan: "ZZZZZ9999Z" }))).rejects.toThrow(/PAN must match/);
    // omitting the PAN keeps the sealed one
    await updateCompanyProfile(s.actor, profile("Profile Co Pvt Ltd"));
    expect((await getCompanyProfile(s.businessId))?.panMasked).toBe(`XXXXX${panFromGstin(g).slice(5)}`);
    expect(await getCompanyProfile(randomUUID())).toBeNull();
  });
  it("an undecryptable stored PAN shows a fully masked placeholder, never the ciphertext", async () => {
    const s = await seller();
    await prisma.business.update({ where: { id: s.businessId }, data: { pan: "garbage-ciphertext" } });
    expect((await getCompanyProfile(s.businessId))?.panMasked).toBe("XXXXXXXXXX");
  });
});

describe("business + directory APIs", () => {
  it("createBusiness validates input, requires a live person, emits BusinessCreated, makes the person owner", async () => {
    const p = await prisma.person.create({ data: { email: `cb-${randomUUID()}@example.test` } });
    personIds.push(p.id);
    await expect(createBusiness(p.id, { name: "x", isSeller: true })).rejects.toThrow();
    await expect(createBusiness(p.id, { name: "Valid Name", pincode: "12", isSeller: true })).rejects.toThrow(/pincode/);
    await expect(createBusiness(randomUUID(), { name: "Valid Name", isSeller: true })).rejects.toMatchObject({ code: "not_found" });
    const er = await prisma.person.create({ data: { erasedAt: new Date() } });
    personIds.push(er.id);
    await expect(createBusiness(er.id, { name: "Valid Name", isSeller: true })).rejects.toMatchObject({ code: "not_found" });
    const { businessId } = await createBusiness(p.id, { name: "  Valid Name  ", city: "Pune", pincode: "", languages: [], isSeller: false });
    bizIds.push(businessId);
    const b = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
    expect(b).toMatchObject({ name: "Valid Name", city: "Pune", pincode: null, languages: ["en"], isSeller: false, isBuyer: true });
    expect(await isBusinessMember(p.id, businessId)).toBe(true);
    expect(await isBusinessMember(randomUUID(), businessId)).toBe(false);
    expect(await listBusinessMembers(businessId)).toEqual([{ personId: p.id, role: "owner" }]);
    expect(await listBusinessMembers(businessId, { ownersOnly: true })).toHaveLength(1);
    expect(await prisma.domainEvent.count({ where: { aggregateId: businessId, type: "BusinessCreated" } })).toBe(1);
    expect(await getPersonBusinesses(p.id)).toEqual([expect.objectContaining({ businessId, role: "owner", isSeller: false, isBuyer: true })]);
    await createBusiness(p.id, { name: "Multi Lang", isSeller: true, languages: ["hi", "en"] }).then((r) => bizIds.push(r.businessId));
  });
  it("updateProfile validates name + language", async () => {
    const p = await prisma.person.create({ data: { email: `up-${randomUUID()}@example.test` } });
    personIds.push(p.id);
    await updateProfile(p.id, { name: "  New Name ", preferredLanguage: "hi" });
    expect(await prisma.person.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ name: "New Name", preferredLanguage: "hi" });
    await updateProfile(p.id, {});
    await expect(updateProfile(p.id, { name: "" })).rejects.toThrow();
    await expect(updateProfile(p.id, { preferredLanguage: "not a lang" })).rejects.toThrow();
    await updateProfile(p.id, { preferredLanguage: "pt-BR" });
  });
  it("getTrustProfiles is cached until the seller's caches are busted", async () => {
    const s = await seller("Cache Co");
    expect((await getTrustProfiles([])).size).toBe(0);
    await getTrustProfiles([s.businessId]); // a fill racing the create-time invalidation may not be stored; the next one is
    await new Promise((r) => setImmediate(r));
    const first = (await getTrustProfiles([s.businessId])).get(s.businessId)!;
    expect(first).toMatchObject({ name: "Cache Co", verificationTier: 0 });
    await prisma.business.update({ where: { id: s.businessId }, data: { trustScore: 77 } });
    expect((await getTrustProfiles([s.businessId])).get(s.businessId)!.trustScore).toBe(first.trustScore); // still cached
    await bustSellerCaches(s.businessId);
    expect((await getTrustProfiles([s.businessId])).get(s.businessId)!.trustScore).toBe(77);
  });
  it("listSellers filters sellers only, by name/city (case-insensitive), badge/trust ordered, limits clamped", async () => {
    const tag = `Zq${randomUUID().slice(0, 6)}`;
    const a = await seller(`${tag} Alpha`);
    const b = await seller(`${tag} Beta`);
    const buyer = await seller(`${tag} Buyer`, false);
    await prisma.business.update({ where: { id: a.businessId }, data: { city: "Pune", trustScore: 10 } });
    await prisma.business.update({ where: { id: b.businessId }, data: { city: "Pune", trustScore: 60, badgeActive: true } });
    await bustSellerCaches(a.businessId);
    const res = await listSellers({ q: tag.toLowerCase(), limit: 500 });
    expect(res.map((r) => r.businessId)).toEqual([b.businessId, a.businessId]);
    expect(res.some((r) => r.businessId === buyer.businessId)).toBe(false);
    expect((await listSellers({ q: ` ${tag} `, city: "PUNE" })).length).toBe(2);
    expect(await listSellers({ q: tag, city: "Delhi" })).toEqual([]);
    expect((await listSellers({ q: tag, limit: 1, offset: 1 })).map((r) => r.businessId)).toEqual([a.businessId]);
    expect((await listSellers({ q: tag, limit: -5, offset: -5 })).length).toBe(1);
  });
  it("listSellerIndex pages in a stable order and clamps its arguments", async () => {
    const page = await listSellerIndex({ offset: -3.7, limit: 2.9 });
    expect(page.length).toBeLessThanOrEqual(2);
    for (const r of page) expect(new Date(r.createdAt).toString()).not.toBe("Invalid Date");
    expect(await listSellerIndex({ offset: 0, limit: 0 })).toHaveLength(page.length > 0 ? 1 : 0);
  });
  it("legacy verifyGstin: each failure mode records a failed check; success emits BusinessVerified and is idempotent on tier", async () => {
    const s = await seller();
    await expect(verifyGstin(randomUUID(), gstin())).rejects.toMatchObject({ code: "not_found" });
    expect(await verifyGstin(s.businessId, "nope")).toMatchObject({ passed: false, tier: 0, reason: expect.stringContaining("Invalid GSTIN") });
    expect(await verifyGstin(s.businessId, gstin(), "UDYAM-X")).toMatchObject({ passed: false, reason: expect.stringContaining("Udyam") });
    expect(await verifyGstin(s.businessId, gstin("N"))).toMatchObject({ passed: false, reason: expect.stringContaining("not found") });
    expect(await verifyGstin(s.businessId, gstin("C"))).toMatchObject({ passed: false, reason: "GSTIN is cancelled." });
    const g = gstin();
    expect(await verifyGstin(s.businessId, ` ${g.toLowerCase()} `, " udyam-mh-12-1234567 ")).toEqual({ passed: true, tier: 1 });
    expect(await prisma.verificationRecord.count({ where: { businessId: s.businessId, kind: "udyam", status: "passed" } })).toBe(1);
    const other = await seller();
    expect(await verifyGstin(other.businessId, g)).toMatchObject({ passed: false, reason: expect.stringContaining("already registered") });
    const recs = await listVerificationRecords(s.businessId);
    expect(recs.length).toBe(6);
    expect(recs.filter((r) => r.status === "failed")).toHaveLength(4);
    expect(recs.every((r) => typeof r.createdAt === "string")).toBe(true);
  });
});

describe("directory lookups honour DPDP", () => {
  it("contact: erased => null; phone only with counterparty_sharing consent unless self", async () => {
    const p = await prisma.person.create({ data: { email: `dc-${randomUUID()}@example.test`, phone: `+9160${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`, name: "Dee" } });
    personIds.push(p.id);
    expect(await getPersonContact(p.id)).toEqual({ email: p.email, phone: null, name: "Dee" });
    expect((await getPersonContact(p.id, { self: true }))?.phone).toBe(p.phone);
    await setConsent(p.id, "counterparty_sharing", true, "web");
    expect((await getPersonContact(p.id))?.phone).toBe(p.phone);
    await setConsent(p.id, "counterparty_sharing", false, "web");
    expect((await getPersonContact(p.id))?.phone).toBeNull();
    expect(await getPersonContact(randomUUID())).toBeNull();
    await prisma.person.update({ where: { id: p.id }, data: { erasedAt: new Date() } });
    expect(await getPersonContact(p.id, { self: true })).toBeNull();
    expect(await isPersonErased(p.id)).toBe(true);
    expect(await isPersonErased(randomUUID())).toBe(true);
  });
  it("email lookup is case-insensitive and never returns erased people; summaries mask email unless unmasked", async () => {
    const p = await prisma.person.create({ data: { email: `look-${randomUUID()}@example.test`, name: "Look" } });
    const e = await prisma.person.create({ data: { email: `gone-${randomUUID()}@example.test`, name: "Gone", erasedAt: new Date() } });
    personIds.push(p.id, e.id);
    expect(await getPersonByEmail(` ${p.email!.toUpperCase()} `)).toEqual({ id: p.id, name: "Look", email: p.email });
    expect(await getPersonByEmail(e.email!)).toBeNull();
    expect(await getPersonByEmail("nobody@example.test")).toBeNull();
    const masked = await getPersonSummaries([p.id, p.id, e.id]);
    expect(masked.size).toBe(2);
    expect(masked.get(p.id)).toEqual({ id: p.id, name: "Look", email: `${p.email![0]}***@example.test` });
    expect(masked.get(e.id)).toEqual({ id: e.id, name: null, email: null });
    expect((await getPersonSummaries([p.id], { unmasked: true })).get(p.id)!.email).toBe(p.email);
    expect((await getPersonSummaries([])).size).toBe(0);
  });
});

it("redis is reachable for cache-busting helpers", async () => {
  expect(await redis.ping()).toBe("PONG");
});
