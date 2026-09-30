import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getGstEvidence: vi.fn(), getTrustProfiles: vi.fn(), escrowHistoryForBusiness: vi.fn(), listEscrowsForBusiness: vi.fn(), getEscrowDetail: vi.fn(), disputeRecordForBusiness: vi.fn(), fundEscrowFromLender: vi.fn(), setEscrowLenderAssignment: vi.fn(),
}));
vi.mock("@cnote/identity", async (orig) => ({ ...(await orig<object>()), getGstEvidence: m.getGstEvidence, getTrustProfiles: m.getTrustProfiles }));
vi.mock("@cnote/escrow", async (orig) => ({ ...(await orig<object>()), escrowHistoryForBusiness: m.escrowHistoryForBusiness, listEscrowsForBusiness: m.listEscrowsForBusiness, getEscrowDetail: m.getEscrowDetail, fundEscrowFromLender: m.fundEscrowFromLender, setEscrowLenderAssignment: m.setEscrowLenderAssignment }));
vi.mock("@cnote/disputes", async (orig) => ({ ...(await orig<object>()), disputeRecordForBusiness: m.disputeRecordForBusiness }));

const { defaultPorts } = await import("../src/adapters");

const row = (o: Record<string, unknown>) => ({ id: "e", orderId: "o", status: "released", frozen: false, amountPaise: 1000, heldPaise: 0, buyerBusinessId: "B", sellerBusinessId: "S", ...o });
beforeEach(() => Object.values(m).forEach((f) => f.mockReset()));

describe("default ports over public exports", () => {
  it("gst: latest non-pending record drives verified/status/filings; none means unverified", async () => {
    m.getGstEvidence.mockResolvedValueOnce([
      { status: "pending", createdAt: "2026-01-03T00:00:00Z", snapshot: null },
      { status: "passed", createdAt: "2026-01-02T00:00:00Z", snapshot: { status: "Active", filings: Array.from({ length: 8 }, (_, i) => ({ period: String(i), filed: i % 2 === 0 })) } },
    ]);
    const g = await defaultPorts.gst("S");
    expect(g).toMatchObject({ verified: true, status: "Active", lastCheckedAt: new Date("2026-01-02T00:00:00Z") });
    expect(g.filings).toHaveLength(6);
    m.getGstEvidence.mockResolvedValueOnce([{ status: "failed", createdAt: "2026-01-02T00:00:00Z", snapshot: null }]);
    expect(await defaultPorts.gst("S")).toMatchObject({ verified: false, status: null, lastCheckedAt: null, filings: [] });
    m.getGstEvidence.mockResolvedValueOnce([]);
    expect((await defaultPorts.gst("S")).verified).toBe(false);
  });
  it("trust: profile or zeros", async () => {
    m.getTrustProfiles.mockResolvedValueOnce(new Map([["S", { trustScore: 77, badgeActive: true }]]));
    expect(await defaultPorts.trust("S")).toEqual({ trustScore: 77, badgeActive: true });
    m.getTrustProfiles.mockResolvedValueOnce(new Map());
    expect(await defaultPorts.trust("S")).toEqual({ trustScore: 0, badgeActive: false });
  });
  it("escrow history: the exact per-business read from @cnote/escrow, no sampling", async () => {
    m.escrowHistoryForBusiness.mockResolvedValue({ completed: 400, completedPaise: 9_000, clean: 398, refunded: 3 });
    expect(await defaultPorts.escrowHistory("S")).toEqual({ completed: 400, completedPaise: 9_000, clean: 398, refunded: 3 });
    expect(m.escrowHistoryForBusiness).toHaveBeenCalledWith("S");
    expect(m.getEscrowDetail).not.toHaveBeenCalled();
  });
  it("disputes: the per-business record from @cnote/disputes (lost at fault, open either side)", async () => {
    m.disputeRecordForBusiness.mockResolvedValue({ lost: 2, open: 1 });
    expect(await defaultPorts.disputes("S")).toEqual({ lost: 2, open: 1 });
    expect(m.disputeRecordForBusiness).toHaveBeenCalledWith("S");
  });
  it("BNPL funding and invoice-financing assignment go through escrow's public API", async () => {
    for (const [out, ok] of [["funded", true], ["duplicate", true], ["amount_mismatch", false], ["ignored", false]] as const) {
      m.fundEscrowFromLender.mockResolvedValueOnce(out);
      expect(await defaultPorts.fundEscrowFromLender("e1", 100, "loan-1")).toBe(ok);
    }
    expect(m.fundEscrowFromLender).toHaveBeenCalledWith("e1", 100, "loan-1");
    const i = { escrowId: "e1", assignmentId: "a1", partner: "mock", partnerLoanRef: "L1", duePaise: 5 };
    await defaultPorts.assignEscrowProceeds(i);
    expect(m.setEscrowLenderAssignment).toHaveBeenCalledWith(i);
  });
  it("escrow facts / funded for seller / net / unknown funding outcome", async () => {
    m.getEscrowDetail.mockResolvedValueOnce(row({ id: "e1" }));
    expect(await defaultPorts.escrowFacts("e1")).toMatchObject({ escrowId: "e1", sellerBusinessId: "S" });
    m.getEscrowDetail.mockResolvedValueOnce(null);
    expect(await defaultPorts.escrowFacts("e2")).toBeNull();
    m.listEscrowsForBusiness.mockResolvedValueOnce({ items: [row({ id: "a", status: "funded" })], nextCursor: "c1" }).mockResolvedValueOnce({ items: [row({ id: "b", status: "funded" })], nextCursor: null });
    expect((await defaultPorts.fundedEscrowsForSeller("S")).map((e) => e.escrowId)).toEqual(["a", "b"]);
    expect(m.listEscrowsForBusiness).toHaveBeenNthCalledWith(1, "S", { role: "seller", status: "funded", cursor: null, limit: 100 });
    expect(m.listEscrowsForBusiness).toHaveBeenNthCalledWith(2, "S", { role: "seller", status: "funded", cursor: "c1", limit: 100 });
    expect(defaultPorts.sellerNetPaise(1_000_000)).toBeLessThan(1_000_000);
    expect(await defaultPorts.fundEscrowFromLender("e", 1, "r")).toBe(false);
  });
});
