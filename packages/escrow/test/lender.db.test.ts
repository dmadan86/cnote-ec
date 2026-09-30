import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { acceptDelivery, createEscrowForOrder, fundEscrowFromLender, getEscrowSnapshotForOrder, processPayouts, setEscrowLenderAssignment } from "../src";
import { onOrderStatusChanged } from "../src/escrow";
import { cleanup, eventsOf, fundedEscrow, ledgerFor, mkOrder, setOrder } from "./helpers";

afterAll(cleanup);
const drive = async (orderId: string, to: "dispatched") => { await setOrder(orderId, to); await onOrderStatusChanged({ orderId, to }); };
const assign = (escrowId: string, duePaise: number, assignmentId = randomUUID()) =>
  setEscrowLenderAssignment({ escrowId, assignmentId, partner: "mock", partnerLoanRef: `L-${assignmentId.slice(0, 6)}`, duePaise }).then(() => assignmentId);

describe("invoice financing: lender paid first at release (ADR-019)", () => {
  it("splits the seller's net proceeds: lender up to the amount due, the rest to the seller; emits EscrowLenderRepaid", async () => {
    const f = await fundedEscrow();
    const assignmentId = await assign(f.escrowId, 500_000);
    await drive(f.orderId, "dispatched");
    await acceptDelivery(f.buyerActor, f.orderId);
    const payouts = await prisma.escrowPayout.findMany({ where: { escrowId: f.escrowId }, orderBy: { kind: "asc" } });
    expect(payouts.map((p) => [p.kind, Number(p.amountPaise)])).toEqual([["lender_repayment", 500_000], ["seller_payout", 482_300]]);
    expect(payouts[0]).toMatchObject({ assignmentRef: assignmentId, beneficiaryRef: expect.stringMatching(/^mock:L-/) });
    expect((await prisma.escrowLenderAssignment.findUniqueOrThrow({ where: { escrowId: f.escrowId } }))).toMatchObject({ status: "cleared", duePaise: 0n });
    await processPayouts();
    const repaid = await eventsOf("EscrowLenderRepaid", payouts[0]!.id);
    expect(repaid).toHaveLength(1);
    expect(repaid[0]!.payload).toMatchObject({ escrowId: f.escrowId, assignmentId, amountPaise: 500_000 });
    expect(await eventsOf("PayoutSettled", payouts[0]!.id)).toHaveLength(0); // payout-latency metric only counts seller payouts
    const l = await ledgerFor(f.escrowId);
    expect(l.debit).toBe(l.credit);
    expect(l.sellerPayable).toBe(0);
  });

  it("when more is due than the proceeds, everything goes to the lender and the assignment stays active for the rest", async () => {
    const f = await fundedEscrow();
    await assign(f.escrowId, 5_000_000);
    await drive(f.orderId, "dispatched");
    await acceptDelivery(f.buyerActor, f.orderId);
    const payouts = await prisma.escrowPayout.findMany({ where: { escrowId: f.escrowId } });
    expect(payouts.map((p) => [p.kind, Number(p.amountPaise)])).toEqual([["lender_repayment", 982_300]]);
    expect(await prisma.escrowLenderAssignment.findUniqueOrThrow({ where: { escrowId: f.escrowId } })).toMatchObject({ status: "active", duePaise: BigInt(5_000_000 - 982_300) });
  });

  it("a cleared assignment (due 0) pays the seller in full; assignment validation", async () => {
    const f = await fundedEscrow();
    const id = await assign(f.escrowId, 100_000);
    await setEscrowLenderAssignment({ escrowId: f.escrowId, assignmentId: id, partner: "mock", partnerLoanRef: "L-x", duePaise: 0 });
    await drive(f.orderId, "dispatched");
    await acceptDelivery(f.buyerActor, f.orderId);
    expect((await prisma.escrowPayout.findMany({ where: { escrowId: f.escrowId } })).map((p) => p.kind)).toEqual(["seller_payout"]);
    await expect(assign(f.escrowId, 1)).rejects.toMatchObject({ code: "conflict" }); // released: nothing left to assign
    await expect(assign("nope", 1)).rejects.toMatchObject({ code: "not_found" });
    await expect(assign(f.escrowId, -1)).rejects.toMatchObject({ code: "validation" });
  });
});

describe("BNPL: lender funds the escrow (ADR-019)", () => {
  it("funds an awaiting escrow once; replays are duplicates; bad inputs are refused", async () => {
    const o = await mkOrder({ status: "confirmed" });
    const v = await createEscrowForOrder(o.buyerActor, o.orderId);
    expect(await fundEscrowFromLender(v.id, 1_000_000, "bnpl-123")).toBe("funded");
    expect(await fundEscrowFromLender(v.id, 1_000_000, "bnpl-123")).toBe("duplicate");
    expect((await getEscrowSnapshotForOrder(o.orderId))!.status).toBe("funded");
    const funded = (await eventsOf("EscrowFunded", v.id))[0]!.payload as { partnerRef: string };
    expect(funded.partnerRef).toBe("lender:bnpl-123");
    expect(await fundEscrowFromLender("nope", 1, "x")).toBe("ignored");
    await expect(fundEscrowFromLender(v.id, 1, "bad ref with spaces")).rejects.toMatchObject({ code: "validation" });
  });
});
