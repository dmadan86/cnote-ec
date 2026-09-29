import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBusiness, createMockGstnProvider, evaluateGstChecks, gstinCheckChar, isValidGstin, listPendingGstReviews, maskPan,
  nameSimilarity, normaliseName, panFromGstin, recheckGstStatus, resolveGstReview, setGstnProvider, updateCompanyProfile, verifyCompanyGst,
  isRecheckDue, getCompanyProfile,
} from "../src";
import { parseCashfree, parseSurepass } from "../src/gst/providers";

const L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const rnd = (n: number, set: string) => Array.from({ length: n }, () => set[Math.floor(Math.random() * set.length)]).join("");
/** Unique, checksum-valid GSTIN; `code` is the 13th char that steers the mock provider. */
function gstin(code = "1", state = "27") {
  const pan = `${rnd(5, L)}${rnd(4, "0123456789")}${rnd(1, L)}`;
  const first14 = `${state}${pan}${code}Z`;
  return first14 + gstinCheckChar(first14);
}

const mock = createMockGstnProvider();
const bizIds: string[] = [];
const personIds: string[] = [];
beforeAll(() => setGstnProvider(mock));
afterAll(async () => {
  setGstnProvider(null);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: bizIds } } });
  await prisma.verificationRecord.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.businessMember.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

async function seller(name: string) {
  const person = await prisma.person.create({ data: { email: `gst-${randomUUID()}@example.test` } });
  personIds.push(person.id);
  const { businessId } = await createBusiness(person.id, { name, isSeller: true });
  bizIds.push(businessId);
  return { actor: { personId: person.id, businessId }, businessId };
}
const address = (stateCode = "27", state = "Maharashtra") => ({ line1: "12 MIDC Road", city: "Pune", state, stateCode, pincode: "411019" });
const profile = (legalName: string, extra: object = {}) => ({ legalName, companyType: "private_limited" as const, registeredAddress: address(), ...extra });

describe("pure helpers", () => {
  it("gstin generator is valid; PAN derived from chars 3-12", () => {
    const g = gstin();
    expect(isValidGstin(g)).toBe(true);
    expect(panFromGstin(g)).toHaveLength(10);
    expect(maskPan("ABCDE1234F")).toBe("XXXXX1234F");
  });
  it("normalises company names", () => {
    expect(normaliseName("M/S Sharma Steel Pvt. Ltd.")).toBe("sharma steel");
    expect(normaliseName("SHARMA STEEL PRIVATE LIMITED")).toBe("sharma steel");
    expect(normaliseName("Rao & Sons LLP")).toBe("rao and sons");
  });
  it("token-set similarity", () => {
    expect(nameSimilarity("Sharma Steel Pvt Ltd", "M/S SHARMA STEEL PRIVATE LIMITED")).toBeGreaterThanOrEqual(0.85);
    expect(nameSimilarity("Steel Sharma", "Sharma Steel")).toBe(1);
    expect(nameSimilarity("Sharma Steel Works", "Sharma Steel Traders")).toBeGreaterThan(0.6);
    expect(nameSimilarity("Sharma Steel Works", "Sharma Steel Traders")).toBeLessThan(0.85);
    expect(nameSimilarity("Sharma Steel", "Completely Different Traders")).toBeLessThan(0.3);
  });
  it("evaluateGstChecks decisions", () => {
    const g = gstin();
    const rec = { legalName: "Sharma Steel Private Limited", state: "Maharashtra", status: "Active" as const };
    const ok = evaluateGstChecks({ gstin: g, record: rec, declared: { names: ["Sharma Steel Pvt Ltd"], pan: panFromGstin(g), stateCode: "27" } });
    expect(ok.decision).toBe("passed");
    expect(evaluateGstChecks({ gstin: g, record: rec, declared: { names: ["Sharma Steel Pvt Ltd"], stateCode: "29" } }).decision).toBe("review");
    expect(evaluateGstChecks({ gstin: g, record: rec, declared: { names: ["Sharma Steel Pvt Ltd"], pan: "AAAAA0000A", stateCode: "27" } }).decision).toBe("failed");
    expect(evaluateGstChecks({ gstin: g, record: { ...rec, status: "Cancelled" }, declared: { names: ["Sharma Steel"], stateCode: "27" } }).decision).toBe("failed");
    const filing = evaluateGstChecks({ gstin: g, record: { ...rec, filings: Array.from({ length: 6 }, (_, i) => ({ period: `2026-0${i + 1}`, filed: i < 2 })) }, declared: { names: ["Sharma Steel"], stateCode: "27" } });
    expect(filing.checks.find((c) => c.id === "filing")?.result).toBe("fail");
    expect(filing.decision).toBe("passed"); // filing is evidence, not a gate
  });
  it("parses vendor payloads", () => {
    const g = gstin();
    const cf = parseCashfree(200, { valid: true, legal_name_of_business: "X LTD", gst_in_status: "Active", date_of_registration: "2017-09-30", principal_place_split_address: { pincode: "781007", state: "Assam" } }, g);
    expect(cf).toMatchObject({ legalName: "X LTD", status: "Active", registrationDate: "2017-09-30" });
    expect(parseCashfree(200, { valid: false }, g)).toBeNull();
    expect(parseSurepass(200, { success: true, data: { legal_name: "Y", business_name: "Y Trade", gstin_status: "Cancelled" } }, g)).toMatchObject({ legalName: "Y", status: "Cancelled" });
  });
  it("recheck scheduling is spread and stable", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    expect(isRecheckDue("a", null, now)).toBe(true);
    expect(isRecheckDue("a", new Date("2026-06-01T00:00:00Z"), now)).toBe(false);
    expect(isRecheckDue("a", new Date("2026-04-01T00:00:00Z"), now)).toBe(true);
  });
});

describe("company profile + verification (db)", () => {
  it("stores PAN encrypted and only reads it masked; rejects PAN/GSTIN mismatch", async () => {
    const { actor, businessId } = await seller("Pan Test Works");
    const g = gstin();
    const pan = panFromGstin(g);
    await expect(updateCompanyProfile(actor, profile("Pan Test Works Pvt Ltd", { gstin: g, pan: "ZZZZZ9999Z" }))).rejects.toThrow(/PAN must match/);
    await expect(updateCompanyProfile(actor, profile("Pan Test Works Pvt Ltd", { cin: "BAD" }))).rejects.toThrow(/CIN/);
    const v = await updateCompanyProfile(actor, profile("Pan Test Works Pvt Ltd", { gstin: g, pan, cin: "U12345MH2019PTC123456", website: "https://example.com" }));
    expect(v.panMasked).toBe(`XXXXX${pan.slice(5)}`);
    const row = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
    expect(row.pan).not.toContain(pan);
    expect(JSON.stringify(await getCompanyProfile(businessId))).not.toContain(pan);
  });

  it("passes → tier 1, GST snapshot, BusinessVerified", async () => {
    const { actor, businessId } = await seller("Alpha Forge");
    const g = gstin();
    await updateCompanyProfile(actor, profile("Alpha Forge Private Limited", { gstin: g, pan: panFromGstin(g) }));
    const o = await verifyCompanyGst(businessId, { gstin: g });
    expect(o.decision).toBe("passed");
    const b = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
    expect(b).toMatchObject({ gstin: g, verificationTier: 1, gstStatus: "Active" });
    expect(b.gstVerifiedAt).not.toBeNull();
    const rec = await prisma.verificationRecord.findFirstOrThrow({ where: { businessId, status: "passed" } });
    expect((rec.details as { checks: unknown[] }).checks.length).toBeGreaterThan(3);
    expect(await prisma.domainEvent.count({ where: { aggregateId: businessId, type: "BusinessVerified" } })).toBe(1);
  });

  it("name mismatch fails; cancelled fails; provider outage changes nothing", async () => {
    const { actor, businessId } = await seller("Beta Castings");
    const bad = gstin("M");
    await updateCompanyProfile(actor, profile("Beta Castings Pvt Ltd"));
    expect((await verifyCompanyGst(businessId, { gstin: bad })).decision).toBe("failed");
    expect((await verifyCompanyGst(businessId, { gstin: gstin("C") })).reasons.join()).toMatch(/cancelled/);
    expect((await verifyCompanyGst(businessId, { gstin: gstin("U") })).decision).toBe("unavailable");
    expect((await prisma.business.findUniqueOrThrow({ where: { id: businessId } })).verificationTier).toBe(0);
  });

  it("ambiguous name → pending review → staff approve", async () => {
    const { actor, businessId } = await seller("Gamma Tools");
    const g = gstin();
    mock.setFixture(g, { legalName: "Gamma Tool Works Traders", state: "Maharashtra", status: "Active" });
    await updateCompanyProfile(actor, profile("Gamma Tools Enterprises"));
    const o = await verifyCompanyGst(businessId, { gstin: g });
    expect(o.decision).toBe("review");
    expect((await prisma.business.findUniqueOrThrow({ where: { id: businessId } })).verificationTier).toBe(0);
    const item = (await listPendingGstReviews(200)).find((r) => r.businessId === businessId);
    expect(item?.gstin).toBe(g);
    const staffId = randomUUID();
    expect(await resolveGstReview(item!.id, "approved", staffId)).toMatchObject({ status: "passed", tier: 1 });
    await expect(resolveGstReview(item!.id, "rejected", staffId)).rejects.toThrow(/already resolved/);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: businessId } })).gstin).toBe(g);
  });

  it("continuous check revokes badge when GSTIN becomes cancelled", async () => {
    const { actor, businessId } = await seller("Delta Alloys");
    const g = gstin();
    await updateCompanyProfile(actor, profile("Delta Alloys Pvt Ltd"));
    expect((await verifyCompanyGst(businessId, { gstin: g })).decision).toBe("passed");
    expect((await recheckGstStatus(businessId))?.revoked).toBe(false);
    mock.setFixture(g, { legalName: "Delta Alloys Pvt Ltd", state: "Maharashtra", status: "Cancelled" });
    expect(await recheckGstStatus(businessId)).toMatchObject({ status: "Cancelled", revoked: true });
    const b = await prisma.business.findUniqueOrThrow({ where: { id: businessId } });
    expect(b).toMatchObject({ verificationTier: 0, badgeActive: false, gstStatus: "Cancelled" });
  });
});
