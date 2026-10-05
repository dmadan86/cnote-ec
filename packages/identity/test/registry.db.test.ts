// Udyam + MCA verification: match scoring, provider parsers, flows, review queue, re-check, trust effect (ADR-003 T1).
import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  addressSimilarity, computeTrustScore, createMockMcaProvider, createMockUdyamProvider, evaluateRegistryChecks, getUdyamProvider, listPendingRegistryReviews,
  parseSurepassMca, parseSurepassUdyam, recheckRegistry, resolveRegistryReview, setMcaProvider, setUdyamProvider, surepassUdyamProvider, verifyMca, verifyUdyam,
} from "../src";
import { recomputeTrust } from "../src/trust-worker";
import { emptySignals } from "../src/trust";

const udyam = (last = "5") => `UDYAM-MH-26-000123${last}`;
const cin = (serial = "123456") => `U12345MH2019PTC${serial}`;
const addr = { line1: "12 MIDC Road", city: "Pune", state: "Maharashtra", stateCode: "27", pincode: "411019" };
const mockU = createMockUdyamProvider();
const mockM = createMockMcaProvider();
const bizIds: string[] = [];
beforeAll(() => { setUdyamProvider(mockU); setMcaProvider(mockM); });
afterEach(() => { mockU.clearFixtures(); mockM.clearFixtures(); delete process.env.UDYAM_GRANTS_T1; });
afterAll(async () => {
  setUdyamProvider(null); setMcaProvider(null);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: bizIds } } });
  await prisma.verificationRecord.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
});
async function biz(o: { udyam?: string; cin?: string; gst?: boolean } = {}) {
  const b = await prisma.business.create({
    data: {
      name: `Sharma Steel ${randomUUID().slice(0, 4)}`, legalName: "Sharma Steel Private Limited", isSeller: true, registeredAddress: addr, city: "Pune", state: "Maharashtra", pincode: "411019",
      udyam: o.udyam, cin: o.cin, ...(o.gst ? { verificationTier: 1, gstVerifiedAt: new Date() } : {}),
    },
  });
  bizIds.push(b.id);
  return b;
}

describe("addressSimilarity", () => {
  it("scores pincode, state, city and street overlap", () => {
    const d = { line: "12 MIDC Road", city: "Pune", state: "Maharashtra", pincode: "411019" };
    expect(addressSimilarity(d, { line: "Plot 12, MIDC, Pune 411019", city: "Pune", state: "Maharashtra", pincode: "411019" })).toBeGreaterThanOrEqual(0.7);
    expect(addressSimilarity(d, { line: "5 Ring Road", city: "Delhi", state: "Delhi", pincode: "110001" })).toBeLessThan(0.4);
  });
  it("pulls the pincode out of a free-text line and skips missing parts", () => {
    expect(addressSimilarity({ pincode: "411019" }, { line: "somewhere 411019" })).toBe(1);
    expect(addressSimilarity({}, {})).toBe(0);
  });
});

describe("evaluateRegistryChecks", () => {
  const rec = (o = {}) => ({ number: udyam(), name: "Sharma Steel", active: true, statusLabel: "Active", address: { line: "12 MIDC Road Pune", pincode: "411019", state: "Maharashtra", city: "Pune" }, ...o });
  const declared = { names: ["Sharma Steel Private Limited"], address: { line: "12 MIDC Road", city: "Pune", state: "Maharashtra", pincode: "411019" } };
  it("passes a clean match", () => expect(evaluateRegistryChecks({ kind: "udyam", number: udyam(), record: rec(), declared })).toMatchObject({ decision: "passed", score: 100 }));
  it("fails an inactive registration and a different number", () => {
    expect(evaluateRegistryChecks({ kind: "mca", number: cin(), record: rec({ number: cin(), active: false, statusLabel: "Struck Off" }), declared }).decision).toBe("failed");
    expect(evaluateRegistryChecks({ kind: "udyam", number: udyam(), record: rec({ number: udyam("9") }), declared }).decision).toBe("failed");
  });
  it("name mismatch fails, partial name or far address reviews, held-by-other reviews", () => {
    expect(evaluateRegistryChecks({ kind: "udyam", number: udyam(), record: rec({ name: "Zebra Plastics" }), declared }).decision).toBe("failed");
    expect(evaluateRegistryChecks({ kind: "udyam", number: udyam(), record: rec({ name: "Sharma Steel Works" }), declared }).decision).toBe("review");
    expect(evaluateRegistryChecks({ kind: "udyam", number: udyam(), record: rec({ address: { line: "9 Far Away", pincode: "110001", state: "Delhi", city: "Delhi" } }), declared }).decision).toBe("review");
    expect(evaluateRegistryChecks({ kind: "udyam", number: udyam(), record: rec(), declared, heldByOther: true }).decision).toBe("review");
  });
});

describe("Surepass parsers", () => {
  it("maps udyam and mca payloads, and the not-found / auth cases", () => {
    const u = parseSurepassUdyam(200, { success: true, data: { main_details: { name_of_enterprise: "Sharma Steel", enterprise_type: "Micro", organization_type: "Proprietorship", date_of_incorporation: "01/04/2020" }, official_address: { address_line1: "12 MIDC", city: "Pune", state: "Maharashtra", pincode: "411019" } } }, udyam());
    expect(u).toMatchObject({ enterpriseName: "Sharma Steel", enterpriseType: "micro", incorporationDate: "2020-04-01", status: "Active", address: { pincode: "411019", city: "Pune" } });
    expect(parseSurepassUdyam(422, {}, udyam())).toBeNull();
    expect(() => parseSurepassUdyam(401, {}, udyam())).toThrow(/auth/);
    const m = parseSurepassMca(200, { data: { company_id: cin(), company_name: "Sharma Steel Pvt Ltd", company_status: "Strike Off", registered_address: "Pune 411019" } }, cin());
    expect(m).toMatchObject({ cin: cin(), status: "Struck Off", address: { line: "Pune 411019" } });
    expect(parseSurepassMca(200, { data: {} }, cin())).toBeNull();
    expect(() => parseSurepassMca(503, {}, cin())).toThrow();
  });
  it("posts the bearer token through the injected fetch and refuses to run without a key", async () => {
    let seen: { url: string; auth: string | null; body: string } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, auth: new Headers(init.headers).get("authorization"), body: String(init.body) };
      return new Response(JSON.stringify({ data: { main_details: { name_of_enterprise: "X" } } }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = surepassUdyamProvider({ REGISTRY_PROVIDER_KEY: "tok", REGISTRY_PROVIDER_BASE_URL: "https://vendor.test" } as never, f);
    expect((await p.lookup(udyam()))?.enterpriseName).toBe("X");
    expect(seen).toMatchObject({ auth: "Bearer tok", body: JSON.stringify({ id_number: udyam() }) });
    await expect(surepassUdyamProvider({} as never, f).lookup(udyam())).rejects.toThrow(/REGISTRY_PROVIDER_KEY/);
  });
  it("factory refuses mock in production and surepass without a key", () => {
    setUdyamProvider(null);
    expect(() => getUdyamProvider({ NODE_ENV: "production" } as never)).toThrow(/not allowed in production/);
    expect(() => getUdyamProvider({ UDYAM_PROVIDER: "surepass" } as never)).toThrow(/REGISTRY_PROVIDER_KEY/);
    expect(() => getUdyamProvider({ UDYAM_PROVIDER: "nope" } as never)).toThrow(/Unknown/);
    setUdyamProvider(mockU);
  });
});

describe("verifyUdyam / verifyMca", () => {
  it("udyam pass stamps the business, records, emits and adds trust points; tier unchanged without the flag", async () => {
    const b = await biz({ udyam: udyam(), gst: true });
    const before = (await recomputeTrust(b.id))!;
    const o = await verifyUdyam(b.id);
    expect(o.decision).toBe("passed");
    const row = await prisma.business.findUniqueOrThrow({ where: { id: b.id } });
    expect(row.udyamVerifiedAt).not.toBeNull();
    expect(row.verificationTier).toBe(1);
    expect(await prisma.verificationRecord.count({ where: { businessId: b.id, kind: "udyam", status: "passed" } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { aggregateId: b.id, type: "BusinessVerified" } })).toBe(1);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: b.id } })).trustScore).toBeGreaterThanOrEqual(before.score);
    expect(computeTrustScore({ ...emptySignals(1), registryVerified: 2 }).score).toBeGreaterThan(computeTrustScore(emptySignals(1)).score);
  });
  it("udyam grants T1 only for a GST-less seller with UDYAM_GRANTS_T1", async () => {
    const off = await biz({ udyam: udyam() });
    await verifyUdyam(off.id);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: off.id } })).verificationTier).toBe(0);
    process.env.UDYAM_GRANTS_T1 = "1";
    const on = await biz({ udyam: udyam("6") });
    await verifyUdyam(on.id);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: on.id } })).verificationTier).toBe(1);
  });
  it("not found / cancelled / unavailable / invalid format", async () => {
    const nf = await biz({ udyam: udyam("0") });
    expect((await verifyUdyam(nf.id)).decision).toBe("failed");
    const cancelled = await biz({ udyam: udyam("1") });
    expect((await verifyUdyam(cancelled.id)).decision).toBe("failed");
    const down = await biz({ udyam: udyam("3") });
    expect((await verifyUdyam(down.id)).decision).toBe("unavailable");
    expect(await prisma.verificationRecord.count({ where: { businessId: down.id } })).toBe(0);
    const bad = await biz({ udyam: "NOPE" });
    expect((await verifyUdyam(bad.id)).decision).toBe("failed");
    await expect(verifyUdyam((await biz()).id)).rejects.toThrow(/Add your Udyam/);
  });
  it("name mismatch from the registry fails; a number verified elsewhere goes to review, and staff can approve", async () => {
    const mism = await biz({ udyam: udyam("2") });
    expect((await verifyUdyam(mism.id)).decision).toBe("failed");
    const first = await biz({ udyam: udyam("7") });
    expect((await verifyUdyam(first.id)).decision).toBe("passed");
    const second = await biz({ udyam: udyam("7") });
    const o = await verifyUdyam(second.id);
    expect(o.decision).toBe("review");
    const pending = (await listPendingRegistryReviews()).find((r) => r.businessId === second.id)!;
    expect(pending).toMatchObject({ kind: "udyam", dispute: true });
    const staff = randomUUID();
    expect(await resolveRegistryReview(pending.id, "approved", staff)).toEqual({ status: "passed" });
    await expect(resolveRegistryReview(pending.id, "rejected", staff)).rejects.toThrow(/already resolved/);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: second.id } })).udyamVerifiedAt).not.toBeNull();
  });
  it("mca pass, struck-off penalty and the periodic re-check clearing the stamp", async () => {
    const b = await biz({ cin: cin() });
    expect((await verifyMca(b.id)).decision).toBe("passed");
    expect((await prisma.business.findUniqueOrThrow({ where: { id: b.id } })).mcaStatus).toBe("Active");
    mockM.setFixture(cin(), { cin: cin(), companyName: "Sharma Steel Private Limited", status: "Struck Off", address: {} });
    expect(await recheckRegistry(b.id)).toEqual({ mca: "Struck Off" });
    const row = await prisma.business.findUniqueOrThrow({ where: { id: b.id } });
    expect(row).toMatchObject({ mcaVerifiedAt: null, mcaStatus: "Struck Off" });
    expect(await prisma.verificationRecord.count({ where: { businessId: b.id, kind: "mca", status: "failed" } })).toBe(1);
    expect(computeTrustScore({ ...emptySignals(1), registryFlag: true }).score).toBeLessThan(computeTrustScore(emptySignals(1)).score);
    const dead = await biz({ cin: cin("123451") });
    expect((await verifyMca(dead.id)).decision).toBe("failed");
    expect((await prisma.business.findUniqueOrThrow({ where: { id: dead.id } })).mcaStatus).toBe("Struck Off");
  });
});
