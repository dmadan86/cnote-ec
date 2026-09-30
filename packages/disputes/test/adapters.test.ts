import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cnote/escrow", () => ({
  getEscrowSnapshotForOrder: vi.fn(async (id: string) => (id === "known" ? { escrowId: "e1", status: "funded", frozen: true, heldPaise: 5000 } : id === "open" ? { escrowId: "e2", status: "funded", frozen: false, heldPaise: 10 } : null)),
}));
vi.mock("@cnote/quality", () => ({
  listChecksForOrder: vi.fn(async () => [{
    checkId: "c1", orderId: "o", sellerBusinessId: "s", categorySlug: "x", verdict: "inconsistent", confidence: 0.8, needsReview: true,
    results: [{ check: "quantity", result: "inconsistent", confidence: 0.8, note: "18 of 20 cartons visible" }, { check: "labelling", result: "consistent", confidence: 0.9, note: "" }],
    photoCount: 3, completedAt: "2026-09-30T00:00:00.000Z", advisory: true, disclaimer: "d",
  }]),
}));

const { escrowAdapter, qualityAdapter, wireDisputeAdapters } = await import("../src/adapters");
const { escrowPort, qualityPort } = await import("../src/ports");

describe("dispute adapters", () => {
  it("maps escrow snapshots (frozen marked) and returns null when there is no escrow", async () => {
    expect(await escrowAdapter.getEscrowForOrder("known")).toEqual({ escrowId: "e1", status: "funded (frozen)", heldPaise: 5000, invoice: null });
    expect(await escrowAdapter.getEscrowForOrder("open")).toMatchObject({ status: "funded" });
    expect(await escrowAdapter.getEscrowForOrder(randomUUID())).toBeNull();
  });
  it("summarises quality checks as advisory evidence", async () => {
    const [c] = await qualityAdapter.listChecksForOrder("o");
    expect(c).toMatchObject({ id: "c1", verdict: "inconsistent", confidence: 0.8, createdAt: "2026-09-30T00:00:00.000Z" });
    expect(c!.summary).toBe("3 dispatch photo(s), advisory only; quantity: inconsistent (18 of 20 cartons visible); labelling: consistent");
  });
  it("wireDisputeAdapters installs both ports once", async () => {
    wireDisputeAdapters();
    wireDisputeAdapters();
    expect(escrowPort()).toBe(escrowAdapter);
    expect(qualityPort()).toBe(qualityAdapter);
  });
});
