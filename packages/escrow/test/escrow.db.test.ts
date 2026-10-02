import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import {
  acceptDelivery, createEscrowForOrder, expireUnfunded, getEscrowDetail, getEscrowForOrder, getEscrowOffer, getEscrowSnapshotForOrder, handleEscrowWebhook, listEscrows,
  processPayouts, quoteEscrow, runAutoRelease, shouldNudgeEscrow, simulateMockFunding, staffRefundEscrow, staffReleaseEscrow, escrowStats, trialBalance,
} from "../src/index";
import { onDisputeOpened, onDisputeResolved, onOrderStatusChanged } from "../src/escrow";
import { DAY, actorOf, cleanup, eventsOf, fundedEscrow, ledgerFor, mkOrder, mock, setOrder, uid } from "./helpers";

afterAll(cleanup);
beforeEach(() => { process.env.ESCROW_ENABLED = "1"; });
afterEach(() => { vi.unstubAllEnvs(); });

const status = async (id: string) => (await prisma.escrowAgreement.findUniqueOrThrow({ where: { id } })).status;
const drive = async (orderId: string, to: "confirmed" | "dispatched" | "delivered" | "completed" | "cancelled") => { await setOrder(orderId, to); await onOrderStatusChanged({ orderId, to }); };

describe("creation and funding", () => {
  it("creates an awaiting_funding escrow with a fee quote, idempotently, and emits EscrowCreated once", async () => {
    const o = await mkOrder({ status: "confirmed" });
    const v = await createEscrowForOrder(o.buyerActor, o.orderId);
    expect(v).toMatchObject({ status: "awaiting_funding", amountPaise: 1_000_000, feePaise: 15_000, feeGstPaise: 2_700, sellerNetPaise: 982_300, role: "buyer" });
    expect(v.checkoutUrl).toMatch(/^mock:\/\//);
    expect(v.actions).toEqual({ fund: true, accept: false });
    expect(v.milestones.map((m) => m.milestone)).toEqual(["confirmed"]);
    const again = await createEscrowForOrder(o.buyerActor, o.orderId);
    expect(again.id).toBe(v.id);
    expect(await eventsOf("EscrowCreated", v.id)).toHaveLength(1);
  });
  it("only the buyer can create; order must be escrowable with a total above the minimum", async () => {
    const o = await mkOrder();
    await expect(createEscrowForOrder(o.sellerActor, o.orderId)).rejects.toMatchObject({ code: "not_found" });
    await expect(createEscrowForOrder(actorOf(uid()), o.orderId)).rejects.toMatchObject({ code: "not_found" });
    const d = await mkOrder({ status: "dispatched" });
    await expect(createEscrowForOrder(d.buyerActor, d.orderId)).rejects.toMatchObject({ code: "conflict" });
    const n = await mkOrder({ total: null });
    await expect(createEscrowForOrder(n.buyerActor, n.orderId)).rejects.toMatchObject({ code: "validation" });
    const s = await mkOrder({ total: 50 });
    await expect(createEscrowForOrder(s.buyerActor, s.orderId)).rejects.toMatchObject({ code: "validation" });
  });
  it("flag off: public functions refuse, views hide actions", async () => {
    const o = await mkOrder();
    const v = await createEscrowForOrder(o.buyerActor, o.orderId);
    process.env.ESCROW_ENABLED = "0";
    await expect(createEscrowForOrder(o.buyerActor, o.orderId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(acceptDelivery(o.buyerActor, o.orderId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(simulateMockFunding(o.buyerActor, o.orderId)).rejects.toMatchObject({ code: "forbidden" });
    expect((await getEscrowForOrder(o.buyerActor, o.orderId))!.actions.fund).toBe(false);
    expect((await getEscrowOffer(o.buyerActor, { id: o.orderId, status: "confirmed", role: "buyer", totalPaise: 1_000_000, counterparty: { businessId: o.seller, name: "x" } })).eligible).toBe(false);
    // money-side keeps working with the flag off
    process.env.ESCROW_ENABLED = "1";
    await simulateMockFunding(o.buyerActor, o.orderId);
    process.env.ESCROW_ENABLED = "0";
    await drive(o.orderId, "dispatched");
    expect(await status(v.id)).toBe("funded");
  });
  it("mock funding goes through the signed webhook, journals the money and emits EscrowFunded; replay is a no-op", async () => {
    const f = await fundedEscrow();
    expect(await status(f.escrowId)).toBe("funded");
    const l = await ledgerFor(f.escrowId);
    expect(l.debit).toBe(l.credit);
    expect(l.escrowHeld).toBe(1_000_000);
    expect(l.nodal).toBe(1_000_000);
    expect(await eventsOf("EscrowFunded", f.escrowId)).toHaveLength(1);
    const { rawBody, headers } = mock().simulateCollect(f.escrowId, 1_000_000);
    const dup = await handleEscrowWebhook("mock", rawBody, headers);
    expect(dup.status).toBe("duplicate");
    expect((await ledgerFor(f.escrowId)).escrowHeld).toBe(1_000_000);
    await expect(simulateMockFunding(f.buyerActor, f.orderId)).rejects.toMatchObject({ code: "conflict" });
  });
  it("H1: webhooks refuse a non-configured partner, the flag-off state, an unset secret, and mock in production", async () => {
    const o = await mkOrder();
    const v = await createEscrowForOrder(o.buyerActor, o.orderId);
    const { rawBody, headers } = mock().simulateCollect(v.id, 1_000_000);
    // a different partner is configured: a validly signed `mock` event is refused as unknown
    process.env.ESCROW_PARTNER = "razorpay_route";
    await expect(handleEscrowWebhook("mock", rawBody, headers)).rejects.toMatchObject({ code: "not_found" });
    delete process.env.ESCROW_PARTNER;
    // flag off
    process.env.ESCROW_ENABLED = "0";
    await expect(handleEscrowWebhook("mock", rawBody, headers)).rejects.toMatchObject({ code: "forbidden" });
    process.env.ESCROW_ENABLED = "1";
    // no default secret: unset secret verifies nothing (a forger using the old public default is refused)
    const forged = JSON.stringify({ id: "forged1", type: "collect.captured", escrowId: v.id, amountPaise: 1_000_000 });
    const { hmac } = await import("../src/partner/util");
    const saved = process.env.ESCROW_WEBHOOK_SECRET;
    delete process.env.ESCROW_WEBHOOK_SECRET;
    await expect(handleEscrowWebhook("mock", forged, { "x-escrow-signature": hmac("mock-escrow-webhook-secret", forged, "hex") })).rejects.toMatchObject({ code: "unauthenticated" });
    process.env.ESCROW_WEBHOOK_SECRET = saved;
    // mock refused in production unless the explicit flag is set
    vi.stubEnv("NODE_ENV", "production");
    await expect(handleEscrowWebhook("mock", rawBody, headers)).rejects.toMatchObject({ code: "not_found" });
    vi.stubEnv("ESCROW_MOCK_CHECKOUT", "1");
    expect((await handleEscrowWebhook("mock", rawBody, headers)).outcome).toBe("funded");
    vi.unstubAllEnvs();
  });
  it("H1: an event from provider X cannot fund or settle an escrow opened with provider Y", async () => {
    const o = await mkOrder();
    const v = await createEscrowForOrder(o.buyerActor, o.orderId);
    await prisma.escrowAgreement.update({ where: { id: v.id }, data: { partner: "cashfree" } });
    const { rawBody, headers } = mock().simulateCollect(v.id, 1_000_000);
    expect((await handleEscrowWebhook("mock", rawBody, headers)).outcome).toBe("partner_mismatch");
    expect(await status(v.id)).toBe("awaiting_funding");
  });
  it("webhook: bad signature, unknown provider, wrong amount, unknown escrow, late funding", async () => {
    const o = await mkOrder();
    const v = await createEscrowForOrder(o.buyerActor, o.orderId);
    await expect(handleEscrowWebhook("mock", "{}", { "x-escrow-signature": "bad" })).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(handleEscrowWebhook("stripe", "{}", {})).rejects.toMatchObject({ code: "not_found" });
    const under = mock().event({ id: `evt-${uid()}`, type: "collect.captured", escrowId: v.id, amountPaise: 5 });
    expect((await handleEscrowWebhook("mock", under.rawBody, under.headers)).outcome).toBe("amount_mismatch");
    expect(await status(v.id)).toBe("awaiting_funding");
    expect(await prisma.escrowReconciliationIssue.count({ where: { escrowId: v.id, kind: "funding_amount_mismatch" } })).toBe(1);
    const unk = mock().event({ id: `evt-${uid()}`, type: "collect.captured", escrowId: uid(), amountPaise: 5 });
    expect((await handleEscrowWebhook("mock", unk.rawBody, unk.headers)).outcome).toBe("unknown_escrow");
    const inv = mock().event({ id: `evt-${uid()}`, type: "collect.captured" });
    expect((await handleEscrowWebhook("mock", inv.rawBody, inv.headers)).outcome).toBe("invalid");
    const ign = mock().event({ id: `evt-${uid()}`, type: "whatever" });
    expect((await handleEscrowWebhook("mock", ign.rawBody, ign.headers)).outcome).toBe("ignored");
    const noPay = mock().event({ id: `evt-${uid()}`, type: "payout.settled" });
    expect((await handleEscrowWebhook("mock", noPay.rawBody, noPay.headers)).outcome).toBe("invalid");
    const noPayF = mock().event({ id: `evt-${uid()}`, type: "payout.failed", payoutId: uid() });
    expect((await handleEscrowWebhook("mock", noPayF.rawBody, noPayF.headers)).outcome).toBe("invalid");
    await drive(o.orderId, "cancelled");
    expect(await status(v.id)).toBe("cancelled");
    const late = mock().event({ id: `evt-${uid()}`, type: "collect.captured", escrowId: v.id, amountPaise: 1_000_000 });
    expect((await handleEscrowWebhook("mock", late.rawBody, late.headers)).outcome).toBe("late_funding");
    expect(await prisma.escrowReconciliationIssue.count({ where: { escrowId: v.id, kind: "late_funding" } })).toBe(1);
  });
  it("mock checkout is refused for non-buyers, unknown ids and production", async () => {
    const o = await mkOrder();
    await createEscrowForOrder(o.buyerActor, o.orderId);
    await expect(simulateMockFunding(o.sellerActor, o.orderId)).rejects.toMatchObject({ code: "not_found" });
    await expect(simulateMockFunding(o.buyerActor, "nope")).rejects.toMatchObject({ code: "not_found" });
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    await expect(simulateMockFunding(o.buyerActor, o.orderId)).rejects.toMatchObject({ code: "forbidden" });
    process.env.NODE_ENV = prev;
    await prisma.escrowAgreement.update({ where: { orderId: o.orderId }, data: { partner: "cashfree" } });
    await expect(simulateMockFunding(o.buyerActor, o.orderId)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("milestones, acceptance and release", () => {
  it("system snapshot: status, frozen and held funds without an actor; null for unknown or malformed ids", async () => {
    const f = await fundedEscrow();
    const snap = await getEscrowSnapshotForOrder(f.orderId);
    expect(snap).toMatchObject({ escrowId: f.escrowId, status: "funded", frozen: false });
    expect(snap!.heldPaise).toBeGreaterThan(0);
    expect(await getEscrowSnapshotForOrder("00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await getEscrowSnapshotForOrder("nope")).toBeNull();
  });
  it("order events drive milestones; buyer acceptance releases with fee, GST, invoice and settles the payout", async () => {
    const f = await fundedEscrow();
    await drive(f.orderId, "dispatched");
    await drive(f.orderId, "dispatched"); // replay: idempotent
    const v = (await getEscrowForOrder(f.buyerActor, f.orderId))!;
    expect(v.milestones.map((m) => m.milestone)).toEqual(expect.arrayContaining(["funded", "confirmed", "dispatched"]));
    expect(v.actions.accept).toBe(true);
    expect((await eventsOf("EscrowMilestoneReached", f.escrowId)).filter((e) => (e.payload as { milestone: string }).milestone === "dispatched")).toHaveLength(1);
    const out = await acceptDelivery(f.buyerActor, f.orderId);
    expect(out.status).toBe("released");
    expect(out).toMatchObject({ releasedPaise: 1_000_000, feeChargedPaise: 15_000 });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: f.orderId } })).status).toBe("delivered");
    const l = await ledgerFor(f.escrowId);
    expect(l.debit).toBe(l.credit);
    expect(l.escrowHeld).toBe(0);
    expect(l.fee).toBe(15_000);
    expect(l.gst).toBe(2_700);
    expect(l.sellerPayable).toBe(982_300);
    const rel = (await eventsOf("EscrowReleased", f.escrowId))[0]!.payload as { cause: string; feePaise: number; amountPaise: number };
    expect(rel).toMatchObject({ cause: "buyer_accepted", feePaise: 15_000, amountPaise: 1_000_000 });
    const e = await prisma.escrowAgreement.findUniqueOrThrow({ where: { id: f.escrowId } });
    expect(e.feeInvoiceId).not.toBeNull();
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: e.feeInvoiceId! } });
    expect(Number(inv.taxablePaise)).toBe(15_000);
    expect(Number(inv.cgstPaise + inv.sgstPaise + inv.igstPaise)).toBe(2_700);
    // payout
    expect((await processPayouts()).settled).toBeGreaterThanOrEqual(1);
    const l2 = await ledgerFor(f.escrowId);
    expect(l2.sellerPayable).toBe(0);
    expect(l2.nodal).toBe(17_700); // fee + GST stay in nodal until swept
    const ps = (await eventsOf("PayoutSettled", (await prisma.escrowPayout.findFirstOrThrow({ where: { escrowId: f.escrowId } })).id))[0]!.payload as { latencyMs: number; amountPaise: number };
    expect(ps.amountPaise).toBe(982_300);
    expect(ps.latencyMs).toBeGreaterThanOrEqual(0);
    expect((await getEscrowForOrder(f.sellerActor, f.orderId))!.payout).toMatchObject({ status: "settled", amountPaise: 982_300 });
    await processPayouts(); // nothing left, idempotent
    expect((await ledgerFor(f.escrowId)).nodal).toBe(17_700);
    // replay accept is a no-op view
    expect((await acceptDelivery(f.buyerActor, f.orderId)).status).toBe("released");
    expect((await trialBalance()).balanced).toBe(true);
  });
  it("accept requires the buyer, a funded escrow, no freeze and a dispatched order", async () => {
    const f = await fundedEscrow();
    await expect(acceptDelivery(f.sellerActor, f.orderId)).rejects.toMatchObject({ code: "not_found" });
    await expect(acceptDelivery(f.buyerActor, "bad")).rejects.toMatchObject({ code: "not_found" });
    await expect(acceptDelivery(f.buyerActor, f.orderId)).rejects.toMatchObject({ code: "conflict" }); // not dispatched
    const u = await mkOrder({ status: "dispatched" });
    await createEscrowForOrder(u.buyerActor, u.orderId).catch(() => {}); // dispatched orders cannot open escrow
    await prisma.escrowAgreement.create({ data: { orderId: u.orderId, buyerBusinessId: u.buyer, sellerBusinessId: u.seller, amountPaise: 1_000_000n, feePaise: 15_000n, partner: "mock" } });
    await expect(acceptDelivery(u.buyerActor, u.orderId)).rejects.toMatchObject({ code: "conflict" }); // not funded
    await drive(f.orderId, "dispatched");
    await onDisputeOpened({ disputeId: uid(), orderId: f.orderId });
    await expect(acceptDelivery(f.buyerActor, f.orderId)).rejects.toMatchObject({ code: "conflict" });
    await expect(staffReleaseEscrow(f.escrowId)).rejects.toMatchObject({ code: "conflict" });
    await expect(staffRefundEscrow(f.escrowId)).rejects.toMatchObject({ code: "conflict" });
  });
  it("order completed by the buyer releases too; the release is not repeated", async () => {
    const f = await fundedEscrow();
    await drive(f.orderId, "dispatched");
    await drive(f.orderId, "delivered");
    await drive(f.orderId, "completed");
    expect(await status(f.escrowId)).toBe("released");
    await drive(f.orderId, "completed");
    expect(await eventsOf("EscrowReleased", f.escrowId)).toHaveLength(1);
    // a terminal escrow ignores later events
    await drive(f.orderId, "cancelled");
    expect(await status(f.escrowId)).toBe("released");
  });
  it("auto-release fires N days after delivery, never before, never while frozen", async () => {
    const f = await fundedEscrow();
    await drive(f.orderId, "dispatched");
    await drive(f.orderId, "delivered");
    const e = await prisma.escrowAgreement.findUniqueOrThrow({ where: { id: f.escrowId } });
    expect(e.autoReleaseAt!.getTime() - e.deliveredAt!.getTime()).toBeCloseTo(7 * DAY, -4);
    await runAutoRelease(new Date(Date.now() + 6 * DAY));
    expect(await status(f.escrowId)).toBe("funded");
    const dispute = uid();
    await onDisputeOpened({ disputeId: dispute, orderId: f.orderId });
    await onDisputeOpened({ disputeId: dispute, orderId: f.orderId }); // idempotent
    expect(await eventsOf("EscrowFrozen", f.escrowId)).toHaveLength(1);
    await runAutoRelease(new Date(Date.now() + 30 * DAY));
    expect(await status(f.escrowId)).toBe("funded");
    expect((await getEscrowForOrder(f.buyerActor, f.orderId))!).toMatchObject({ frozen: true, actions: { accept: false } });
    // withdrawn dispute: resumes, clock restarts, then auto-release works
    await onDisputeResolved({ disputeId: dispute, refundPaise: 0, releasePaise: 0 });
    expect(await eventsOf("EscrowUnfrozen", f.escrowId)).toHaveLength(1);
    await onDisputeResolved({ disputeId: dispute, refundPaise: 0, releasePaise: 0 }); // replay
    expect(await eventsOf("EscrowUnfrozen", f.escrowId)).toHaveLength(1);
    expect(await status(f.escrowId)).toBe("funded");
    expect(await runAutoRelease(new Date(Date.now() + 8 * DAY))).toBeGreaterThanOrEqual(1);
    expect(await status(f.escrowId)).toBe("released");
    expect((await eventsOf("EscrowReleased", f.escrowId))[0]!.payload).toMatchObject({ cause: "auto_release" });
  });
  it("funding after delivery starts the release clock at funding", async () => {
    const o = await mkOrder({ status: "confirmed" });
    const v = await createEscrowForOrder(o.buyerActor, o.orderId);
    await drive(o.orderId, "dispatched");
    await drive(o.orderId, "delivered");
    expect((await prisma.escrowAgreement.findUniqueOrThrow({ where: { id: v.id } })).autoReleaseAt).toBeNull();
    await simulateMockFunding(o.buyerActor, o.orderId);
    expect((await prisma.escrowAgreement.findUniqueOrThrow({ where: { id: v.id } })).autoReleaseAt).not.toBeNull();
  });
});

describe("disputes", () => {
  it("split resolution: release part (fee on the released part) and refund the rest, then unfreeze", async () => {
    const f = await fundedEscrow();
    await drive(f.orderId, "dispatched");
    const d = uid();
    await onDisputeOpened({ disputeId: d, orderId: f.orderId });
    await onDisputeResolved({ disputeId: d, refundPaise: 400_000, releasePaise: 600_000 });
    const e = await prisma.escrowAgreement.findUniqueOrThrow({ where: { id: f.escrowId } });
    expect(e).toMatchObject({ status: "released", frozen: false });
    expect(Number(e.releasedPaise)).toBe(600_000);
    expect(Number(e.refundedPaise)).toBe(400_000);
    expect(Number(e.feeChargedPaise)).toBe(9_000);
    const l = await ledgerFor(f.escrowId);
    expect(l.debit).toBe(l.credit);
    expect(l.escrowHeld).toBe(0);
    expect(l.sellerPayable).toBe(600_000 - 9_000 - 1_620);
    expect(l.refundPayable).toBe(400_000);
    expect((await eventsOf("EscrowReleased", f.escrowId))[0]!.payload).toMatchObject({ cause: "dispute_resolution", amountPaise: 600_000 });
    expect((await eventsOf("EscrowRefunded", f.escrowId))[0]!.payload).toMatchObject({ cause: "dispute_resolution", amountPaise: 400_000 });
    await processPayouts();
    const l2 = await ledgerFor(f.escrowId);
    expect(l2.sellerPayable).toBe(0);
    expect(l2.refundPayable).toBe(0);
    expect(l2.nodal).toBe(9_000 + 1_620);
  });
  it("full refund to the buyer ends refunded; over-large decisions are clamped to what is held", async () => {
    const f = await fundedEscrow();
    const d = uid();
    await onDisputeOpened({ disputeId: d, orderId: f.orderId });
    await onDisputeResolved({ disputeId: d, refundPaise: 5_000_000, releasePaise: 5_000_000 });
    expect(await status(f.escrowId)).toBe("refunded");
    const e = await prisma.escrowAgreement.findUniqueOrThrow({ where: { id: f.escrowId } });
    expect(Number(e.refundedPaise)).toBe(1_000_000);
    expect(Number(e.releasedPaise)).toBe(0);
  });
  it("a second open dispute keeps the overlay and moves no money until it resolves too", async () => {
    const f = await fundedEscrow();
    const [d1, d2] = [uid(), uid()];
    await onDisputeOpened({ disputeId: d1, orderId: f.orderId });
    await onDisputeOpened({ disputeId: d2, orderId: f.orderId });
    await onDisputeResolved({ disputeId: d1, refundPaise: 1_000_000, releasePaise: 0 });
    expect(await status(f.escrowId)).toBe("funded");
    expect((await prisma.escrowAgreement.findUniqueOrThrow({ where: { id: f.escrowId } })).frozen).toBe(true);
    await onDisputeResolved({ disputeId: d2, refundPaise: 0, releasePaise: 1_000_000 });
    expect(await status(f.escrowId)).toBe("released");
  });
  it("disputes on unknown/terminal escrows and unknown disputes are ignored", async () => {
    await onDisputeOpened({ disputeId: uid(), orderId: uid() });
    await onDisputeResolved({ disputeId: uid(), refundPaise: 1, releasePaise: 1 });
    const f = await fundedEscrow();
    await staffReleaseEscrow(f.escrowId);
    await onDisputeOpened({ disputeId: uid(), orderId: f.orderId });
    expect(await eventsOf("EscrowFrozen", f.escrowId)).toHaveLength(0);
    // freeze while unfunded, resolve later: nothing to move
    const o = await mkOrder();
    const v = await createEscrowForOrder(o.buyerActor, o.orderId);
    const d = uid();
    await onDisputeOpened({ disputeId: d, orderId: o.orderId });
    await onDisputeResolved({ disputeId: d, refundPaise: 5, releasePaise: 5 });
    expect(await status(v.id)).toBe("awaiting_funding");
  });
});

describe("cancel, expiry, staff", () => {
  it("cancelling a funded order refunds in full; cancelling an unfunded one closes with a zero refund event", async () => {
    const f = await fundedEscrow();
    await drive(f.orderId, "cancelled");
    expect(await status(f.escrowId)).toBe("refunded");
    expect((await eventsOf("EscrowRefunded", f.escrowId))[0]!.payload).toMatchObject({ cause: "cancelled", amountPaise: 1_000_000 });
    const o = await mkOrder();
    const v = await createEscrowForOrder(o.buyerActor, o.orderId);
    await drive(o.orderId, "cancelled");
    expect(await status(v.id)).toBe("cancelled");
    expect((await eventsOf("EscrowRefunded", v.id))[0]!.payload).toMatchObject({ cause: "cancelled", amountPaise: 0 });
  });
  it("unfunded escrows lapse after the TTL and the buyer can reopen", async () => {
    const o = await mkOrder();
    const v = await createEscrowForOrder(o.buyerActor, o.orderId);
    await prisma.escrowAgreement.update({ where: { id: v.id }, data: { fundingExpiresAt: new Date(Date.now() - 1000) } });
    expect(await expireUnfunded()).toBeGreaterThanOrEqual(1);
    expect(await status(v.id)).toBe("cancelled");
    expect((await eventsOf("EscrowRefunded", v.id))[0]!.payload).toMatchObject({ cause: "funding_expired" });
    const again = await createEscrowForOrder(o.buyerActor, o.orderId);
    expect(again).toMatchObject({ id: v.id, status: "awaiting_funding" });
  });
  it("staff release / refund of held funds; nothing held is a conflict", async () => {
    const a = await fundedEscrow();
    expect((await staffReleaseEscrow(a.escrowId)).status).toBe("released");
    await expect(staffReleaseEscrow(a.escrowId)).rejects.toMatchObject({ code: "conflict" });
    const b = await fundedEscrow();
    expect((await staffRefundEscrow(b.escrowId)).status).toBe("refunded");
    await expect(staffRefundEscrow("bad")).rejects.toMatchObject({ code: "not_found" });
    await expect(staffRefundEscrow(uid())).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("payout retries and pending settlement", () => {
  it("a pending partner payout settles on the webhook; failures retry and eventually surface an issue", async () => {
    const { MockPartner, setEscrowPartner } = await import("../src/index");
    const pm = new MockPartner({ payoutStatus: "pending" });
    setEscrowPartner(pm);
    try {
      const f = await fundedEscrow();
      await staffReleaseEscrow(f.escrowId);
      const r = await processPayouts();
      expect(r.submitted).toBeGreaterThanOrEqual(1);
      const p = await prisma.escrowPayout.findFirstOrThrow({ where: { escrowId: f.escrowId } });
      expect(p).toMatchObject({ status: "pending" });
      expect(p.submittedAt).not.toBeNull();
      const fail = pm.event({ id: `f-${uid()}`, type: "payout.failed", payoutId: p.id });
      expect((await handleEscrowWebhook("mock", fail.rawBody, fail.headers)).outcome).toBe("retry_queued");
      expect((await prisma.escrowPayout.findUniqueOrThrow({ where: { id: p.id } })).submittedAt).toBeNull();
      await processPayouts();
      const ok = pm.event({ id: `s-${uid()}`, type: "payout.settled", payoutId: p.id, partnerRef: "ref" });
      expect((await handleEscrowWebhook("mock", ok.rawBody, ok.headers)).outcome).toBe("settled");
      const ok2 = pm.event({ id: `s-${uid()}`, type: "payout.settled", payoutId: p.id });
      expect((await handleEscrowWebhook("mock", ok2.rawBody, ok2.headers)).outcome).toBe("duplicate");
      const unk = pm.event({ id: `s-${uid()}`, type: "payout.settled", payoutId: uid() });
      expect((await handleEscrowWebhook("mock", unk.rawBody, unk.headers)).outcome).toBe("not_found");
      expect((await prisma.escrowPayout.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("settled");
    } finally { setEscrowPartner(null); }
  });
  it("partner errors count attempts, then mark failed with an issue; stuck submissions are flagged", async () => {
    const f = await fundedEscrow();
    await staffReleaseEscrow(f.escrowId);
    await prisma.escrowAgreement.update({ where: { id: f.escrowId }, data: { partner: "razorpay_route" } });
    for (let i = 0; i < 8; i++) await processPayouts();
    const p = await prisma.escrowPayout.findFirstOrThrow({ where: { escrowId: f.escrowId } });
    expect(p).toMatchObject({ status: "failed", attempts: 8 });
    expect(await prisma.escrowReconciliationIssue.count({ where: { escrowId: f.escrowId, kind: "payout_failed" } })).toBe(1);
    const g = await fundedEscrow();
    await staffReleaseEscrow(g.escrowId);
    const q = await prisma.escrowPayout.findFirstOrThrow({ where: { escrowId: g.escrowId } });
    await prisma.escrowPayout.update({ where: { id: q.id }, data: { submittedAt: new Date(Date.now() - 3 * DAY) } });
    await processPayouts();
    expect(await prisma.escrowReconciliationIssue.count({ where: { escrowId: g.escrowId, kind: "payout_stuck" } })).toBe(1);
  });
});

describe("reads, nudge and stats", () => {
  it("nudges first-time counterparties only", async () => {
    const o = await mkOrder({ status: "confirmed" });
    expect(await shouldNudgeEscrow(o.buyer, o.seller)).toBe(true);
    await mkOrder({ buyer: o.buyer, seller: o.seller, status: "completed" });
    expect(await shouldNudgeEscrow(o.buyer, o.seller)).toBe(false);
    const offer = await getEscrowOffer(o.buyerActor, { id: o.orderId, status: "confirmed", role: "buyer", totalPaise: 1_000_000, counterparty: { businessId: o.seller, name: "x" } });
    expect(offer).toMatchObject({ enabled: true, eligible: true, nudge: false });
    expect(offer.quote!.feePaise).toBe(15_000);
    const seller = await getEscrowOffer(o.sellerActor, { id: o.orderId, status: "confirmed", role: "seller", totalPaise: 1_000_000, counterparty: { businessId: o.buyer, name: "x" } });
    expect(seller).toMatchObject({ eligible: false, nudge: false, quote: null });
  });
  it("nudge paginates through many orders", async () => {
    const o = await mkOrder({ status: "confirmed" });
    for (let i = 0; i < 21; i++) await mkOrder({ buyer: o.buyer, status: "confirmed" });
    expect(await shouldNudgeEscrow(o.buyer, o.seller)).toBe(true);
  });
  it("views are participant-only; lists, details and stats work", async () => {
    const f = await fundedEscrow();
    expect(await getEscrowForOrder(actorOf(uid()), f.orderId)).toBeNull();
    expect(await getEscrowForOrder(f.buyerActor, "bad")).toBeNull();
    expect((await getEscrowForOrder(f.sellerActor, f.orderId))!.role).toBe("seller");
    expect((await listEscrows({ status: "funded", frozen: false })).some((r) => r.id === f.escrowId)).toBe(true);
    expect((await listEscrows()).length).toBeGreaterThan(0);
    const d = (await getEscrowDetail(f.escrowId))!;
    expect(d).toMatchObject({ status: "funded", heldPaise: 1_000_000 });
    expect(d.milestones.length).toBeGreaterThan(0);
    expect(await getEscrowDetail("bad")).toBeNull();
    expect(await getEscrowDetail(uid())).toBeNull();
    expect(quoteEscrow(1_000_000)).toMatchObject({ feeBps: 150, capPaise: 500_000, gstRateBps: 1800 });
    await staffReleaseEscrow(f.escrowId);
    await processPayouts();
    const st = await escrowStats({ from: new Date(Date.now() - DAY), to: new Date(Date.now() + DAY) });
    expect(st.funded).toBeGreaterThan(0);
    expect(st.payoutLatency.count).toBeGreaterThan(0);
    expect(st.payoutLatency.withinOneDayShare).toBeGreaterThan(0);
    expect(st.fundedPaise).toBeGreaterThan(0);
  });
  it("participant view of a not-yet-funded escrow keeps accept disabled", async () => {
    const o = await mkOrder();
    const v = await createEscrowForOrder(o.buyerActor, o.orderId);
    expect(v.actions.accept).toBe(false);
    expect(v.payout).toBeNull();
    await expect(new Promise((_, r) => r(new DomainError("validation", "x")))).rejects.toBeInstanceOf(DomainError);
  });
});
