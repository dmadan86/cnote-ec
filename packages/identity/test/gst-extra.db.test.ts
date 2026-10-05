// GST verification: tier fallback after a claim release, sparse review/evidence rows, approvals without a snapshot, the daily job and the legacy Udyam path.
import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createBusiness, createMockGstnProvider, evaluateGstChecks, getGstEvidence, gstinCheckChar, gstWorkerJobs, listPendingGstReviews, releaseGstinClaim, resolveGstReview, runGstRecheck,
  setGstnProvider, updateCompanyProfile, verifyCompanyGst, verifyGstin,
} from "../src";

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
afterEach(() => mock.clearFixtures());
afterAll(async () => {
  setGstnProvider(null);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: [...bizIds, ...personIds] } } });
  await prisma.verificationRecord.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.businessMember.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});
async function seller(name = `Gx ${randomUUID().slice(0, 8)}`) {
  const person = await prisma.person.create({ data: { email: `gx-${randomUUID()}@example.test`, name: "Owner" } });
  personIds.push(person.id);
  const { businessId } = await createBusiness(person.id, { name, isSeller: true });
  bizIds.push(businessId);
  return { personId: person.id, businessId, actor: { personId: person.id, businessId }, name };
}
const rec = (businessId: string, kind: "gstin" | "udyam" | "mca" | "document", extra: { tier?: number; provider?: string; details?: unknown; status?: "passed" | "failed" | "pending" } = {}) =>
  prisma.verificationRecord.create({ data: { businessId, tier: extra.tier ?? 1, kind, status: extra.status ?? "passed", provider: extra.provider ?? "x", details: (extra.details ?? {}) as never } });

describe("releaseGstinClaim keeps tiers earned without GST", () => {
  it("ignores gstin, format-check udyam and supplementary registry passes, but keeps document tiers and udyam/mca that granted T1", async () => {
    const a = await seller();
    await prisma.business.update({ where: { id: a.businessId }, data: { gstin: gstin(), gstVerifiedAt: new Date(), verificationTier: 2 } });
    await rec(a.businessId, "gstin");
    await rec(a.businessId, "udyam", { provider: "format-check" });
    await rec(a.businessId, "udyam", { provider: "surepass", details: null });
    await rec(a.businessId, "mca", { details: { grantedT1: false } });
    await rec(a.businessId, "document", { tier: 2 });
    await releaseGstinClaim(a.businessId, "staff", "Reported by owner");
    expect((await prisma.business.findUniqueOrThrow({ where: { id: a.businessId } })).verificationTier).toBe(2);

    const b = await seller();
    await prisma.business.update({ where: { id: b.businessId }, data: { gstin: gstin(), gstVerifiedAt: new Date(), verificationTier: 1 } });
    await rec(b.businessId, "gstin");
    await rec(b.businessId, "udyam", { provider: "surepass", details: { grantedT1: true } });
    await releaseGstinClaim(b.businessId, "staff", "Reported by owner");
    expect((await prisma.business.findUniqueOrThrow({ where: { id: b.businessId } })).verificationTier).toBe(1);

    const c = await seller();
    await prisma.business.update({ where: { id: c.businessId }, data: { gstin: gstin(), gstVerifiedAt: new Date(), verificationTier: 1 } });
    await rec(c.businessId, "gstin");
    await rec(c.businessId, "mca", { details: {} });
    await releaseGstinClaim(c.businessId, "staff", "Reported by owner");
    expect((await prisma.business.findUniqueOrThrow({ where: { id: c.businessId } })).verificationTier).toBe(0);
  });
});

describe("sparse rows", () => {
  it("listPendingGstReviews defaults missing details; getGstEvidence defaults every field", async () => {
    const s = await seller();
    const pending = await rec(s.businessId, "gstin", { status: "pending", details: null });
    const item = (await listPendingGstReviews(200)).find((r) => r.id === pending.id)!;
    expect(item).toMatchObject({ gstin: null, score: null, reasons: [], dispute: false });
    const [e] = await getGstEvidence(s.businessId, 0);
    expect(e).toMatchObject({ gstin: null, decision: null, score: null, recheck: false, checks: [], reasons: [], snapshot: null, manualReview: null });
    expect((await getGstEvidence(s.businessId, 1000)).length).toBe(1);
  });
});

describe("resolveGstReview approval without a snapshot", () => {
  it("passes with gstStatus defaulting to Active and adopts no legal name", async () => {
    const s = await seller();
    const g = gstin();
    const pending = await rec(s.businessId, "gstin", { status: "pending", details: { gstin: g } });
    expect(await resolveGstReview(pending.id, "approved", randomUUID())).toEqual({ status: "passed", tier: 1 });
    const row = await prisma.business.findUniqueOrThrow({ where: { id: s.businessId } });
    expect(row).toMatchObject({ gstin: g, gstStatus: "Active", legalName: null });
  });
  it("a dispute item moves the GSTIN from its (weak) holder", async () => {
    const holder = await seller();
    const claimant = await seller();
    const g = gstin();
    await prisma.business.update({ where: { id: holder.businessId }, data: { gstin: g } });
    const pending = await rec(claimant.businessId, "gstin", { status: "pending", details: { gstin: g, dispute: true, snapshot: { legalName: "Whatever Ltd", state: "Maharashtra", status: "Active" } } });
    expect(await resolveGstReview(pending.id, "approved", randomUUID())).toMatchObject({ status: "passed" });
    expect((await prisma.business.findUniqueOrThrow({ where: { id: holder.businessId } })).gstin).toBeNull();
    expect((await prisma.business.findUniqueOrThrow({ where: { id: claimant.businessId } })).legalName).toBe("Whatever Ltd");
  });
});

describe("evaluateGstChecks with no scoreable checks", () => {
  it("scores zero when everything was skipped (defensive branch)", () => {
    const o = evaluateGstChecks({ gstin: gstin(), record: { legalName: "", state: null, status: "Active" }, declared: { names: [] } });
    expect(o.score).toBeGreaterThanOrEqual(0);
    expect(["passed", "review", "failed"]).toContain(o.decision);
  });
});

describe("daily job and the legacy form entry", () => {
  it("gstWorkerJobs runs a recheck pass", async () => {
    expect(gstWorkerJobs[0]!.name).toBe("identity.gst-recheck");
    await expect(gstWorkerJobs[0]!.run()).resolves.toBeUndefined();
    expect(await runGstRecheck(new Date(), 0)).toEqual({ checked: 0, revoked: 0 });
  });
  it("verifyGstin rejects a malformed Udyam, and records a valid one only when the GSTIN passes", async () => {
    const s = await seller("Udy Works");
    const g = gstin();
    const bad = await verifyGstin(s.businessId, g, "udyam-bad");
    expect(bad).toMatchObject({ passed: false, reason: expect.stringMatching(/Invalid Udyam/) });
    await expect(verifyGstin(randomUUID(), g)).rejects.toMatchObject({ code: "not_found" });

    await updateCompanyProfile(s.actor, { legalName: "Udy Works Pvt Ltd", companyType: "private_limited", registeredAddress: { line1: "12 MIDC Road", city: "Pune", state: "Maharashtra", stateCode: "27", pincode: "411019" } });
    const ok = await verifyGstin(s.businessId, g, " udyam-mh-26-0001235 ");
    expect(ok.passed).toBe(true);
    const row = await prisma.business.findUniqueOrThrow({ where: { id: s.businessId } });
    expect(row.udyam).toBe("UDYAM-MH-26-0001235");
    expect(await prisma.verificationRecord.count({ where: { businessId: s.businessId, kind: "udyam", provider: "format-check" } })).toBe(1);
  });
  it("verifyGstin reports failure wording for a cancelled registration and an unknown one", async () => {
    const s = await seller("Cancelled Co");
    const g = gstin();
    mock.setFixture(g, { legalName: "Cancelled Co", state: "Maharashtra", status: "Cancelled" });
    expect(await verifyGstin(s.businessId, g)).toMatchObject({ passed: false, reason: "GSTIN is cancelled." });
    const g2 = gstin("N");
    expect((await verifyGstin(s.businessId, g2)).reason).toMatch(/not found/);
    const o = await verifyCompanyGst(s.businessId, { gstin: g });
    expect(o.decision).toBe("failed");
  });
});
