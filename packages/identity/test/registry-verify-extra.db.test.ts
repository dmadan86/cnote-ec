// Udyam / MCA verification: edge cases, error paths, review queue guards and the periodic re-check (ADR-003 T1).
import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createMockMcaProvider, createMockUdyamProvider, evaluateRegistryChecks, getRegistryStatus, isValidRegistryNumber, listPendingRegistryReviews, recheckRegistry,
  registryWorkerJobs, resolveRegistryReview, runRegistryRecheck, setMcaProvider, setUdyamProvider, verifyMca, verifyRegistry, verifyUdyam,
} from "../src";

const udyam = (last = "5") => `UDYAM-MH-26-000987${last}`;
const cin = (serial = "654329") => `U54321MH2019PTC${serial}`;
const mockU = createMockUdyamProvider();
const mockM = createMockMcaProvider();
const bizIds: string[] = [];
beforeAll(() => { setUdyamProvider(mockU); setMcaProvider(mockM); });
afterEach(() => { mockU.clearFixtures(); mockM.clearFixtures(); setUdyamProvider(mockU); setMcaProvider(mockM); vi.restoreAllMocks(); });
afterAll(async () => {
  setUdyamProvider(null); setMcaProvider(null);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: bizIds } } });
  await prisma.verificationRecord.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
});
async function biz(o: Record<string, unknown> = {}) {
  const b = await prisma.business.create({ data: { name: `Verma Metals ${randomUUID().slice(0, 4)}`, isSeller: true, city: "Nashik", state: "Maharashtra", pincode: "422001", ...o } });
  bizIds.push(b.id);
  return b;
}

describe("evaluateRegistryChecks edge cases", () => {
  const rec = (o = {}) => ({ number: udyam(), name: "Verma Metals", active: true, statusLabel: "Active", address: {}, ...o });
  it("no declared names, or a record without a name, asks for a manual look", () => {
    const a = evaluateRegistryChecks({ kind: "udyam", number: udyam(), record: rec(), declared: { names: [], address: null } });
    expect(a.checks.find((c) => c.id === "name")?.result).toBe("warn");
    expect(a.decision).toBe("review");
    expect(a.nameScore).toBeUndefined();
    const b = evaluateRegistryChecks({ kind: "mca", number: cin(), record: rec({ number: cin(), name: "" }), declared: { names: ["Verma Metals"], address: null } });
    expect(b.checks.find((c) => c.id === "name")?.result).toBe("warn");
  });
  it("address: skipped with no declared side or no registry data; partial match passes; far match warns", () => {
    const declared = { names: ["Verma Metals"], address: { line: "Plot 4 Satpur MIDC", city: "Nashik", state: "Maharashtra", pincode: "422007" } };
    const skipDeclared = evaluateRegistryChecks({ kind: "udyam", number: udyam(), record: rec({ address: { line: "x", pincode: "422007" } }), declared: { ...declared, address: null } });
    expect(skipDeclared.checks.find((c) => c.id === "address")?.result).toBe("skip");
    expect(skipDeclared.addressScore).toBeUndefined();
    const skipRecord = evaluateRegistryChecks({ kind: "udyam", number: udyam(), record: rec({ address: { city: "Nashik" } }), declared });
    expect(skipRecord.checks.find((c) => c.id === "address")?.result).toBe("skip");
    expect(skipRecord.decision).toBe("passed");
    // same state and city but different pincode and street: between the review and pass thresholds
    const partial = evaluateRegistryChecks({ kind: "udyam", number: udyam(), record: rec({ address: { line: "Gat 9 Ambad", city: "Nashik", state: "Maharashtra", pincode: "422010" } }), declared });
    const pc = partial.checks.find((c) => c.id === "address")!;
    expect(pc.result).toBe("pass");
    expect(pc.detail).toMatch(/partly matches/);
    const far = evaluateRegistryChecks({ kind: "udyam", number: udyam(), record: rec({ address: { line: "5 Ring Road", city: "Delhi", state: "Delhi", pincode: "110001" } }), declared });
    expect(far.checks.find((c) => c.id === "address")?.result).toBe("warn");
    expect(far.decision).toBe("review");
    expect(far.score).toBeLessThan(100);
  });
  it("a status failure is described with the lower-cased registry status", () => {
    const o = evaluateRegistryChecks({ kind: "mca", number: cin(), record: rec({ number: cin(), active: false, statusLabel: "Under Liquidation" }), declared: { names: ["Verma Metals"], address: null } });
    expect(o.reasons[0]).toMatch(/under liquidation/);
  });
});

describe("isValidRegistryNumber", () => {
  it("validates by kind", () => {
    expect(isValidRegistryNumber("udyam", udyam())).toBe(true);
    expect(isValidRegistryNumber("udyam", cin())).toBe(false);
    expect(isValidRegistryNumber("mca", cin())).toBe(true);
    expect(isValidRegistryNumber("mca", udyam())).toBe(false);
  });
});

describe("verifyRegistry", () => {
  it("unknown business and missing CIN", async () => {
    await expect(verifyRegistry("udyam", randomUUID())).rejects.toMatchObject({ code: "not_found" });
    await expect(verifyMca((await biz()).id)).rejects.toThrow(/Add your CIN/);
  });
  it("normalises a supplied udyam number (case, spaces) and uses it instead of the stored one", async () => {
    const b = await biz({ udyam: "stale" });
    const o = await verifyUdyam(b.id, { number: ` ${udyam().toLowerCase().replace(/-/g, " - ")}`.replace(/ - /g, "-").replace("-", " -") });
    expect(o.number).toBe(udyam());
    expect(o.decision).toBe("passed");
  });
  it("an invalid CIN is recorded as failed", async () => {
    const b = await biz({ cin: "short" });
    const o = await verifyMca(b.id);
    expect(o).toMatchObject({ decision: "failed", score: 0 });
    expect(o.reasons[0]).toMatch(/Invalid CIN/);
    expect(await prisma.verificationRecord.count({ where: { businessId: b.id, kind: "mca", status: "failed" } })).toBe(1);
  });
  it("mca not found stamps mcaLastCheckedAt; udyam provider errors that are not provider errors propagate", async () => {
    const b = await biz({ cin: cin("654320") });
    expect((await verifyMca(b.id)).decision).toBe("failed");
    expect((await prisma.business.findUniqueOrThrow({ where: { id: b.id } })).mcaLastCheckedAt).not.toBeNull();
    setUdyamProvider({ name: "boom", lookup: async () => { throw new TypeError("kaboom"); } });
    const u = await biz({ udyam: udyam() });
    await expect(verifyUdyam(u.id)).rejects.toThrow(/kaboom/);
  });
  it("an unconfigured provider reports unavailable under the name 'unconfigured'", async () => {
    setUdyamProvider(null);
    const prev = process.env.UDYAM_PROVIDER;
    process.env.UDYAM_PROVIDER = "nope";
    try {
      const o = await verifyUdyam((await biz({ udyam: udyam() })).id);
      expect(o).toMatchObject({ decision: "unavailable", provider: "unconfigured" });
    } finally {
      if (prev === undefined) delete process.env.UDYAM_PROVIDER; else process.env.UDYAM_PROVIDER = prev;
    }
  });
  it("uses the structured registered address (line1 + line2) and falls back to city/state/pincode, or none", async () => {
    let seen: unknown;
    setUdyamProvider({ name: "spy", lookup: async (n, opts) => { seen = opts; return { udyamNumber: n, enterpriseName: opts?.businessName ?? "?", status: "Active", address: {} }; } });
    await verifyUdyam((await biz({ udyam: udyam(), registeredAddress: { line1: "Plot 4", line2: "Satpur", city: "Nashik", state: "Maharashtra", pincode: "422007" } })).id);
    expect(seen).toMatchObject({ address: { line: "Plot 4, Satpur", pincode: "422007" } });
    await verifyUdyam((await biz({ udyam: udyam("6") })).id);
    expect(seen).toMatchObject({ address: { city: "Nashik", state: "Maharashtra", pincode: "422001" } });
    await verifyUdyam((await biz({ udyam: udyam("7"), city: null, state: null, pincode: null })).id);
    expect((seen as { address?: unknown }).address).toBeUndefined();
  });
  it("mca: review (name partly matches) is queued once and refreshed, a number held elsewhere is a dispute", async () => {
    mockM.setFixture(cin("654322"), { cin: cin("654322"), companyName: "Verma Metals Works Limited", status: "Active", address: {} });
    const b = await biz({ cin: cin("654322"), legalName: "Verma Metals" });
    const o = await verifyMca(b.id);
    expect(o.decision).toBe("review");
    await verifyMca(b.id); // second pass updates the pending record instead of adding one
    expect(await prisma.verificationRecord.count({ where: { businessId: b.id, kind: "mca", status: "pending" } })).toBe(1);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: b.id } })).mcaLastCheckedAt).not.toBeNull();

    mockM.setFixture(cin("654324"), { cin: cin("654324"), companyName: "Verma Metals", status: "Active", address: {} });
    const holder = await biz({ cin: cin("654324"), legalName: "Verma Metals" });
    expect((await verifyMca(holder.id)).decision).toBe("passed");
    const claimant = await biz({ cin: cin("654324"), legalName: "Verma Metals" });
    expect((await verifyMca(claimant.id)).decision).toBe("review");
    expect((await listPendingRegistryReviews()).find((r) => r.businessId === claimant.id)).toMatchObject({ kind: "mca", dispute: true, number: cin("654324") });
  });
  it("a cancelled udyam fails without changing the verification stamp path; an inactive company clears via afterChange", async () => {
    const u = await biz({ udyam: udyam("1") });
    const o = await verifyUdyam(u.id);
    expect(o.decision).toBe("failed");
    expect((await prisma.business.findUniqueOrThrow({ where: { id: u.id } })).udyamLastCheckedAt).not.toBeNull();
    mockM.setFixture(cin("654325"), { cin: cin("654325"), companyName: "Verma Metals", status: "Under Liquidation", address: {} });
    const m = await biz({ cin: cin("654325"), legalName: "Verma Metals" });
    expect((await verifyMca(m.id)).decision).toBe("failed");
    expect((await prisma.business.findUniqueOrThrow({ where: { id: m.id } })).mcaStatus).toBe("Under Liquidation");
  });
});

describe("getRegistryStatus", () => {
  it("returns null for unknown, and the declared numbers for known", async () => {
    expect(await getRegistryStatus(randomUUID())).toBeNull();
    const b = await biz({ udyam: udyam(), udyamVerifiedAt: new Date(), cin: cin(), mcaVerifiedAt: new Date(), mcaStatus: "Active" });
    expect(await getRegistryStatus(b.id)).toMatchObject({ udyam: udyam(), cin: cin(), mcaStatus: "Active", udyamVerifiedAt: expect.any(String), mcaVerifiedAt: expect.any(String) });
    const plain = await biz();
    expect(await getRegistryStatus(plain.id)).toMatchObject({ udyam: null, udyamVerifiedAt: null, mcaVerifiedAt: null });
  });
});

describe("review queue", () => {
  async function pending(details: unknown, kind = "udyam", businessId?: string) {
    const b = businessId ?? (await biz()).id;
    return prisma.verificationRecord.create({ data: { businessId: b, tier: 1, kind: kind as never, status: "pending", provider: "mock", details: details as never } });
  }
  it("lists with defaults for sparse details and clamps the limit", async () => {
    const r = await pending(null);
    const sparse = (await listPendingRegistryReviews(200)).find((x) => x.id === r.id);
    expect(sparse).toMatchObject({ number: null, score: null, reasons: [], dispute: false });
    expect((await listPendingRegistryReviews(0)).length).toBe(1);
    expect((await listPendingRegistryReviews(100_000)).length).toBeLessThanOrEqual(200);
  });
  it("unknown id, wrong kind and already-resolved reviews are refused", async () => {
    const staff = randomUUID();
    await expect(resolveRegistryReview(randomUUID(), "approved", staff)).rejects.toMatchObject({ code: "not_found" });
    const gst = await pending({}, "gstin");
    await expect(resolveRegistryReview(gst.id, "approved", staff)).rejects.toMatchObject({ code: "not_found" });
    const done = await prisma.verificationRecord.create({ data: { businessId: (await biz()).id, tier: 1, kind: "udyam", status: "passed", provider: "mock", details: {} } });
    await expect(resolveRegistryReview(done.id, "approved", staff)).rejects.toMatchObject({ code: "conflict" });
  });
  it("rejection fails the record with the note; approval without a number is refused", async () => {
    const staff = randomUUID();
    const r = await pending({ number: udyam() });
    expect(await resolveRegistryReview(r.id, "rejected", staff, "documents do not match")).toEqual({ status: "failed" });
    const row = await prisma.verificationRecord.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe("failed");
    expect(row.details).toMatchObject({ manualReview: { decision: "rejected", staffId: staff, note: "documents do not match" } });
    const noNumber = await pending({});
    await expect(resolveRegistryReview(noNumber.id, "approved", staff)).rejects.toThrow(/no number/);
  });
  it("loses a claim race with a conflict", async () => {
    const r = await pending({ number: udyam() });
    vi.spyOn(prisma.verificationRecord, "updateMany").mockResolvedValueOnce({ count: 0 });
    await expect(resolveRegistryReview(r.id, "approved", randomUUID())).rejects.toMatchObject({ code: "conflict" });
  });
  it("reverts the record to pending when applying the approval fails", async () => {
    const b = await biz({ cin: cin() });
    const r = await pending({ number: cin(), snapshot: { cin: cin(), companyName: "X", status: "Active", address: {} } }, "mca", b.id);
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("db down"));
    await expect(resolveRegistryReview(r.id, "approved", randomUUID())).rejects.toThrow(/db down/);
    expect((await prisma.verificationRecord.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("pending");
    // approving an mca review without a snapshot defaults the stored status to Active
    const r2 = await pending({ number: cin("654326") }, "mca", b.id);
    expect(await resolveRegistryReview(r2.id, "approved", randomUUID())).toEqual({ status: "passed" });
    expect((await prisma.business.findUniqueOrThrow({ where: { id: b.id } })).mcaStatus).toBe("Active");
  });
});

describe("recheckRegistry / runRegistryRecheck", () => {
  const old = new Date(Date.now() - 200 * 86_400_000);
  it("unknown business returns null; unverified numbers are skipped", async () => {
    expect(await recheckRegistry(randomUUID())).toBeNull();
    expect(await recheckRegistry((await biz({ udyam: udyam(), cin: cin() })).id)).toEqual({});
  });
  it("active registrations only refresh the check date", async () => {
    const b = await biz({ udyam: udyam(), udyamVerifiedAt: old, cin: cin(), mcaVerifiedAt: old });
    expect(await recheckRegistry(b.id)).toEqual({ udyam: "Active", mca: "Active" });
    const row = await prisma.business.findUniqueOrThrow({ where: { id: b.id } });
    expect(row.udyamVerifiedAt).not.toBeNull();
    expect(row.mcaVerifiedAt).not.toBeNull();
    expect(row.mcaStatus).toBe("Active");
  });
  it("a cancelled or vanished udyam and a vanished company clear their stamps and record failures", async () => {
    const b = await biz({ udyam: udyam("1"), udyamVerifiedAt: old, cin: cin("654320"), mcaVerifiedAt: old });
    expect(await recheckRegistry(b.id)).toEqual({ udyam: "Cancelled", mca: "not_found" });
    const row = await prisma.business.findUniqueOrThrow({ where: { id: b.id } });
    expect(row).toMatchObject({ udyamVerifiedAt: null, mcaVerifiedAt: null, mcaStatus: "Inactive" });
    expect(await prisma.verificationRecord.count({ where: { businessId: b.id, status: "failed" } })).toBe(2);
    const gone = await biz({ udyam: udyam("0"), udyamVerifiedAt: old });
    expect(await recheckRegistry(gone.id)).toEqual({ udyam: "not_found" });
  });
  it("provider outages are swallowed, other errors propagate", async () => {
    const b = await biz({ udyam: udyam("3"), udyamVerifiedAt: old, cin: cin("654323"), mcaVerifiedAt: old });
    expect(await recheckRegistry(b.id)).toEqual({});
    setUdyamProvider({ name: "boom", lookup: async () => { throw new TypeError("kaboom"); } });
    await expect(recheckRegistry(b.id)).rejects.toThrow(/kaboom/);
    setUdyamProvider(mockU);
    setMcaProvider({ name: "boom", lookup: async () => { throw new TypeError("kaboom-mca"); } });
    await expect(recheckRegistry(b.id)).rejects.toThrow(/kaboom-mca/);
  });
  it("runRegistryRecheck picks businesses whose last check is past the window", async () => {
    const b = await biz({ udyam: udyam(), udyamVerifiedAt: old, udyamLastCheckedAt: old });
    const n = await runRegistryRecheck(new Date(), 1000);
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: b.id } })).udyamLastCheckedAt!.getTime()).toBeGreaterThan(old.getTime());
    const c = await biz({ cin: cin(), mcaVerifiedAt: old, mcaLastCheckedAt: old });
    await registryWorkerJobs[0]!.run();
    expect((await prisma.business.findUniqueOrThrow({ where: { id: c.id } })).mcaLastCheckedAt!.getTime()).toBeGreaterThan(old.getTime());
    expect(registryWorkerJobs[0]!.name).toBe("identity.registry-recheck");
  });
});
