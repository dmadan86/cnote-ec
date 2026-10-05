// The module worker wires domain events, schedules and queues to the right functions; cascadeSafe never throws.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  closeUnapprovedEnquiry: vi.fn(async () => undefined),
  resumeApprovedEnquiry: vi.fn(async () => undefined),
  resumeApprovedQuote: vi.fn(async () => undefined),
  markOrderEscrowed: vi.fn(async () => true),
  expireOverdueOffers: vi.fn(async () => 2),
  repairCascades: vi.fn(async () => 0),
  sweepStuckScoring: vi.fn(async () => 0),
  sendPayableReminders: vi.fn(async () => 1),
  handleDispatchJob: vi.fn(async () => undefined),
  resolveReachabilityChecks: vi.fn(async () => 3),
  cascade: vi.fn(async () => undefined),
}));

vi.mock("../src/approvals", () => ({ closeUnapprovedEnquiry: m.closeUnapprovedEnquiry, resumeApprovedEnquiry: m.resumeApprovedEnquiry }));
vi.mock("../src/comparison", () => ({ resumeApprovedQuote: m.resumeApprovedQuote }));
vi.mock("../src/orders", () => ({ markOrderEscrowed: m.markOrderEscrowed }));
vi.mock("../src/leads", () => ({ expireOverdueOffers: m.expireOverdueOffers, repairCascades: m.repairCascades, sweepStuckScoring: m.sweepStuckScoring }));
vi.mock("../src/supplier-invoices", () => ({ sendPayableReminders: m.sendPayableReminders }));
vi.mock("../src/reachability", () => ({ REACHABILITY_DISPATCH_TOPIC: "enquiry.reachability_dispatch", handleDispatchJob: m.handleDispatchJob, resolveReachabilityChecks: m.resolveReachabilityChecks }));
vi.mock("../src/matching", () => ({ cascade: m.cascade }));

import { cascadeSafe } from "../src/safe";
import { worker } from "../src/worker";

const event = (type: string, payload: Record<string, unknown>) => ({ id: 1, type, version: 1, aggregateType: "x", aggregateId: "y", occurredAt: "", payload }) as never;

beforeEach(() => vi.clearAllMocks());

describe("worker handlers", () => {
  it("flips settlement to escrow when the partner confirms funding", async () => {
    await worker.handlers.EscrowFunded!(event("EscrowFunded", { orderId: "o1" }));
    expect(m.markOrderEscrowed).toHaveBeenCalledWith("o1");
  });

  it("resumes approved enquiries and quotes, ignores other subjects", async () => {
    await worker.handlers.ApprovalApproved!(event("ApprovalApproved", { subjectType: "enquiry", subjectId: "e" }));
    await worker.handlers.ApprovalApproved!(event("ApprovalApproved", { subjectType: "quote", subjectId: "q" }));
    await worker.handlers.ApprovalApproved!(event("ApprovalApproved", { subjectType: "purchase_order", subjectId: "p" }));
    expect(m.resumeApprovedEnquiry).toHaveBeenCalledTimes(1);
    expect(m.resumeApprovedQuote).toHaveBeenCalledTimes(1);
  });

  it("closes only rejected enquiries (a rejected quote just stays undecided)", async () => {
    await worker.handlers.ApprovalRejected!(event("ApprovalRejected", { subjectType: "enquiry", subjectId: "e" }));
    await worker.handlers.ApprovalRejected!(event("ApprovalRejected", { subjectType: "quote", subjectId: "q" }));
    expect(m.closeUnapprovedEnquiry).toHaveBeenCalledTimes(1);
  });
});

describe("worker jobs and queues", () => {
  const job = (name: string) => worker.jobs!.find((j) => j.name === name)!;

  it("registers each schedule once with a positive interval", () => {
    const names = worker.jobs!.map((j) => j.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["enquiry.expire-offers", "enquiry.repair", "enquiry.resolve-reachability", "enquiry.payable-reminders"]));
    expect(worker.jobs!.every((j) => j.everyMs > 0)).toBe(true);
  });

  it("runs the sweeps", async () => {
    await job("enquiry.expire-offers").run();
    expect(m.expireOverdueOffers).toHaveBeenCalled();
    await job("enquiry.repair").run();
    expect(m.repairCascades).toHaveBeenCalled();
    expect(m.sweepStuckScoring).toHaveBeenCalled();
    await job("enquiry.resolve-reachability").run();
    expect(m.resolveReachabilityChecks).toHaveBeenCalled();
    await job("enquiry.payable-reminders").run();
    expect(m.sendPayableReminders).toHaveBeenCalled();
  });

  it("consumes the reachability dispatch queue by check id", async () => {
    const q = worker.queues!.find((c) => c.topic === "enquiry.reachability_dispatch")!;
    expect(q).toBeDefined();
    await (q as unknown as { handler: (msg: unknown) => Promise<void> }).handler({ payload: { checkId: "c1" } });
    expect(m.handleDispatchJob).toHaveBeenCalledWith("c1");
  });
});

describe("cascadeSafe", () => {
  it("cascades after commit", async () => {
    await cascadeSafe("e1");
    expect(m.cascade).toHaveBeenCalledWith("e1");
  });

  it("logs and swallows a failure; the sweep job retries", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    m.cascade.mockRejectedValueOnce(new Error("db down"));
    await expect(cascadeSafe("e2")).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("[enquiry] cascade failed", "e2", expect.any(Error));
    log.mockRestore();
  });
});
