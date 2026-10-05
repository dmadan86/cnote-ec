// Escrow agreements (ADR-012): creation, funding, milestones, release/refund settlement, freeze overlay, reads.
// All state changes + ledger journals + domain events happen in one prisma.$transaction (ADR-007).
import { issueInvoiceTx, platformSupplier, type Recipient } from "@cnote/billing";
import { DomainError, emit } from "@cnote/core";
import { prisma, type EscrowAgreement, type Tx } from "@cnote/db";
import { getOrder, getOrderParties, listOrders, transitionOrder, type Actor, type OrderView } from "@cnote/enquiry";
import { getBusinessBillingProfile } from "@cnote/identity";
import { assertEscrowEnabled, autoReleaseDays, DAY_MS, escrowEnabled, feeBps, feeCapPaise, fundingTtlHours, gstRateBps, minAmountPaise } from "./config";
import { computeFee, feeBreakdown } from "./fee";
import { ACCOUNTS, postJournal } from "./ledger";
import { configuredPartnerName, getEscrowPartner } from "./partner";
import {
  ESCROWABLE_ORDER_STATUSES, HOLDING_STATUSES, canTransition, isHolding, isTerminal, milestoneForOrderStatus,
  type EscrowStatus, type Milestone, type RefundCause, type ReleaseCause,
} from "./state";

const UUID = /^[0-9a-f-]{36}$/i;
const num = (b: bigint | null | undefined): number => Number(b ?? 0n);
const system = (businessId: string): Actor => ({ personId: "00000000-0000-0000-0000-000000000000", businessId });

// ---- views -------------------------------------------------------------------------------------------------------

export interface EscrowView {
  id: string;
  orderId: string;
  role: "buyer" | "seller";
  status: EscrowStatus;
  frozen: boolean;
  amountPaise: number;
  /** Fee on the full amount, charged to the seller (never the buyer). */
  feePaise: number;
  feeGstPaise: number;
  sellerNetPaise: number;
  partner: string;
  checkoutUrl: string | null;
  fundingExpiresAt: string | null;
  fundedAt: string | null;
  autoReleaseAt: string | null;
  releasedPaise: number;
  refundedPaise: number;
  feeChargedPaise: number;
  milestones: { milestone: Milestone; at: string }[];
  payout: { status: string; amountPaise: number; settledAt: string | null; latencyMs: number | null } | null;
  actions: { fund: boolean; accept: boolean };
  createdAt: string;
}

export interface FeeQuote { amountPaise: number; feePaise: number; gstPaise: number; sellerNetPaise: number; feeBps: number; capPaise: number; gstRateBps: number }

/** Fee disclosure for an order value (shown before anyone opts in). */
export function quoteEscrow(amountPaise: number): FeeQuote {
  const b = feeBreakdown(amountPaise);
  return { amountPaise, feePaise: b.feePaise, gstPaise: b.gstPaise, sellerNetPaise: b.netPaise, feeBps: feeBps(), capPaise: feeCapPaise(), gstRateBps: gstRateBps() };
}

async function viewOf(e: EscrowAgreement, role: "buyer" | "seller"): Promise<EscrowView> {
  const [ms, payout] = await Promise.all([
    prisma.escrowMilestone.findMany({ where: { escrowId: e.id }, orderBy: { at: "asc" } }),
    prisma.escrowPayout.findFirst({ where: { escrowId: e.id, kind: "seller_payout" }, orderBy: { requestedAt: "desc" } }),
  ]);
  const b = feeBreakdown(num(e.amountPaise));
  const status = e.status as EscrowStatus;
  const shipped = !!(e.dispatchedAt || e.deliveredAt);
  return {
    id: e.id, orderId: e.orderId, role, status, frozen: e.frozen,
    amountPaise: num(e.amountPaise), feePaise: b.feePaise, feeGstPaise: b.gstPaise, sellerNetPaise: b.netPaise,
    partner: e.partner, checkoutUrl: e.checkoutUrl, fundingExpiresAt: e.fundingExpiresAt?.toISOString() ?? null,
    fundedAt: e.fundedAt?.toISOString() ?? null, autoReleaseAt: e.autoReleaseAt?.toISOString() ?? null,
    releasedPaise: num(e.releasedPaise), refundedPaise: num(e.refundedPaise), feeChargedPaise: num(e.feeChargedPaise),
    milestones: ms.map((m) => ({ milestone: m.milestone as Milestone, at: m.at.toISOString() })),
    payout: payout ? { status: payout.status, amountPaise: num(payout.amountPaise), settledAt: payout.settledAt?.toISOString() ?? null, latencyMs: payout.latencyMs } : null,
    actions: {
      fund: role === "buyer" && (status === "created" || status === "awaiting_funding") && escrowEnabled(),
      accept: role === "buyer" && status === "funded" && !e.frozen && shipped && escrowEnabled(),
    },
    createdAt: e.createdAt.toISOString(),
  };
}

// ---- internals shared with payouts/webhook/worker -----------------------------------------------------------------

export async function lockEscrow(tx: Tx, id: string): Promise<EscrowAgreement> {
  await tx.$queryRaw`SELECT id FROM escrow_agreements WHERE id = ${id}::uuid FOR UPDATE`;
  return tx.escrowAgreement.findUniqueOrThrow({ where: { id } });
}

const COLUMN = { funded: "fundedAt", confirmed: "confirmedAt", dispatched: "dispatchedAt", delivered: "deliveredAt", accepted: "acceptedAt" } as const;
const EVENT_MILESTONES = new Set<Milestone>(["confirmed", "dispatched", "delivered", "accepted"]);

/** Records a milestone once (unique per escrow), stamps its column and emits EscrowMilestoneReached for the four order milestones. */
export async function stamp(tx: Tx, e: EscrowAgreement, m: Milestone, source: string, at: Date = new Date()): Promise<{ row: EscrowAgreement; isNew: boolean }> {
  const r = await tx.escrowMilestone.createMany({ data: [{ escrowId: e.id, milestone: m, source, at }], skipDuplicates: true });
  if (r.count === 0) return { row: e, isNew: false };
  let row = e;
  if (m in COLUMN) row = await tx.escrowAgreement.update({ where: { id: e.id }, data: { [COLUMN[m as keyof typeof COLUMN]]: at } });
  if (EVENT_MILESTONES.has(m)) {
    await emit(tx, "EscrowMilestoneReached", { type: "escrow", id: e.id }, { escrowId: e.id, orderId: e.orderId, milestone: m as "confirmed" | "dispatched" | "delivered" | "accepted" });
  }
  return { row, isNew: true };
}

export async function openIssue(
  tx: Tx,
  i: { dedupeKey: string; kind: string; escrowId?: string | null; partnerRef?: string | null; expectedPaise?: number | null; actualPaise?: number | null; detail: string },
): Promise<boolean> {
  const r = await tx.escrowReconciliationIssue.createMany({
    data: [{
      dedupeKey: i.dedupeKey, kind: i.kind, escrowId: i.escrowId ?? null, partnerRef: i.partnerRef ?? null, detail: i.detail,
      expectedPaise: i.expectedPaise == null ? null : BigInt(i.expectedPaise), actualPaise: i.actualPaise == null ? null : BigInt(i.actualPaise),
    }],
    skipDuplicates: true,
  });
  return r.count === 1;
}

const heldOf = (e: EscrowAgreement): number => (isHolding(e.status as EscrowStatus) ? num(e.amountPaise) - num(e.releasedPaise) - num(e.refundedPaise) : 0);
export { heldOf };

async function setStatus(tx: Tx, e: EscrowAgreement, to: EscrowStatus, data: Record<string, unknown> = {}): Promise<EscrowAgreement> {
  const from = e.status as EscrowStatus;
  if (from !== to && !canTransition(from, to)) throw new DomainError("conflict", `Escrow cannot move from ${from} to ${to}.`);
  return tx.escrowAgreement.update({ where: { id: e.id }, data: { status: to, ...data } });
}

/** Seller billing identity for the fee invoice; null when the profile is missing (release must not fail on it). */
async function feeRecipient(businessId: string): Promise<Recipient | null> {
  try {
    const p = await getBusinessBillingProfile(businessId);
    return p ? { name: p.name, gstin: p.gstin, address: p.address, stateCode: p.stateCode } : null;
  } catch {
    return null;
  }
}

// ---- settlement (release and/or refund of held funds) --------------------------------------------------------------

export interface SettleInput {
  releasePaise: number;
  refundPaise: number;
  releaseCause?: ReleaseCause;
  refundCause?: RefundCause;
  /** Dispute resolution settles while the escrow is still frozen. Nothing else may. */
  allowFrozen?: boolean;
  source: "buyer" | "system" | "staff" | "dispute";
  feeParty?: Recipient | null;
}

/**
 * Moves held funds: release (to the seller, less fee + GST) and/or refund (to the buyer). Posts the ledger journals,
 * queues the partner transfers (EscrowPayout), emits events, and closes the escrow once nothing remains held.
 * Caller holds the row lock (lockEscrow). Idempotent per (escrow, released/refunded so far) through the journal keys.
 */
export async function settleTx(tx: Tx, e0: EscrowAgreement, i: SettleInput): Promise<EscrowAgreement> {
  let e = e0;
  if (!isHolding(e.status as EscrowStatus)) throw new DomainError("conflict", `Escrow is ${e.status}: there are no funds to move.`);
  if (e.frozen && !i.allowFrozen) throw new DomainError("conflict", "Escrow is frozen while a dispute is open.");
  const held = heldOf(e);
  if (!Number.isSafeInteger(i.releasePaise) || !Number.isSafeInteger(i.refundPaise) || i.releasePaise < 0 || i.refundPaise < 0) {
    throw new DomainError("validation", "Amounts must be whole paise.");
  }
  if (i.releasePaise + i.refundPaise === 0) throw new DomainError("validation", "Nothing to settle.", undefined, "escrow.nothingSettle");
  if (i.releasePaise + i.refundPaise > held) throw new DomainError("validation", "Amount exceeds the funds held in escrow.");
  const now = new Date();
  let feeCharged = 0;
  let invoiceId = e.feeInvoiceId;

  if (i.releasePaise > 0) {
    const fee = computeFee(i.releasePaise);
    const b = feeBreakdown(i.releasePaise);
    if (fee > 0 && i.feeParty) {
      const inv = await issueInvoiceTx(tx, {
        kind: "tax_invoice", businessId: e.sellerBusinessId, recipient: i.feeParty,
        lines: [{ description: `Escrow service fee, order ${e.orderId.slice(0, 8)}`, sac: platformSupplier().sac, quantity: 1, unitPaise: fee, gstRateBps: gstRateBps() }],
      });
      invoiceId = inv.id;
    }
    feeCharged = b.feePaise;
    await postJournal(tx, {
      key: `release:${e.id}:${num(e.releasedPaise)}`, kind: "release", escrowId: e.id,
      memo: `Release ${i.releasePaise} for order ${e.orderId} (fee ${b.feePaise}, gst ${b.gstPaise})`,
      lines: [
        { account: ACCOUNTS.escrow(e.orderId), debitPaise: i.releasePaise },
        { account: ACCOUNTS.sellerPayable(e.sellerBusinessId), creditPaise: b.netPaise },
        ...(b.feePaise > 0 ? [{ account: ACCOUNTS.fee, creditPaise: b.feePaise }] : []),
        ...(b.gstPaise > 0 ? [{ account: ACCOUNTS.gst, creditPaise: b.gstPaise }] : []),
      ],
    });
    // Invoice financing (ADR-019): proceeds assigned to a lender are paid to it first, the remainder to the seller.
    const asg = await tx.escrowLenderAssignment.findUnique({ where: { escrowId: e.id } });
    const toLender = asg && asg.status === "active" ? Math.min(b.netPaise, num(asg.duePaise)) : 0;
    if (toLender > 0) {
      await tx.escrowPayout.create({
        data: { escrowId: e.id, kind: "lender_repayment", businessId: e.sellerBusinessId, amountPaise: BigInt(toLender), requestedAt: now, assignmentRef: asg!.assignmentId, beneficiaryRef: `${asg!.partner}:${asg!.partnerLoanRef}` },
      });
      await tx.escrowLenderAssignment.update({ where: { escrowId: e.id }, data: { duePaise: { decrement: BigInt(toLender) }, ...(toLender >= num(asg!.duePaise) ? { status: "cleared" } : {}) } });
    }
    if (b.netPaise - toLender > 0) {
      await tx.escrowPayout.create({ data: { escrowId: e.id, kind: "seller_payout", businessId: e.sellerBusinessId, amountPaise: BigInt(b.netPaise - toLender), requestedAt: now } });
    }
    await emit(tx, "EscrowReleased", { type: "escrow", id: e.id }, {
      escrowId: e.id, orderId: e.orderId, sellerBusinessId: e.sellerBusinessId, amountPaise: i.releasePaise, feePaise: b.feePaise, cause: i.releaseCause ?? "staff",
    });
  }
  if (i.refundPaise > 0) {
    await postJournal(tx, {
      key: `refund:${e.id}:${num(e.refundedPaise)}`, kind: "refund", escrowId: e.id, memo: `Refund ${i.refundPaise} for order ${e.orderId}`,
      lines: [
        { account: ACCOUNTS.escrow(e.orderId), debitPaise: i.refundPaise },
        { account: ACCOUNTS.refundPayable(e.buyerBusinessId), creditPaise: i.refundPaise },
      ],
    });
    await tx.escrowPayout.create({ data: { escrowId: e.id, kind: "buyer_refund", businessId: e.buyerBusinessId, amountPaise: BigInt(i.refundPaise), requestedAt: now } });
    await emit(tx, "EscrowRefunded", { type: "escrow", id: e.id }, {
      escrowId: e.id, orderId: e.orderId, buyerBusinessId: e.buyerBusinessId, amountPaise: i.refundPaise, cause: i.refundCause ?? "staff",
    });
  }
  const released = num(e.releasedPaise) + i.releasePaise;
  const refunded = num(e.refundedPaise) + i.refundPaise;
  const drained = released + refunded >= num(e.amountPaise);
  const base = { releasedPaise: BigInt(released), refundedPaise: BigInt(refunded), feeChargedPaise: BigInt(num(e.feeChargedPaise) + feeCharged), feeInvoiceId: invoiceId };
  if (drained) {
    e = await setStatus(tx, e, released > 0 ? "released" : "refunded", { ...base, closedAt: now, autoReleaseAt: null });
    await stamp(tx, e, released > 0 ? "released" : "refunded", i.source, now);
  } else {
    e = await tx.escrowAgreement.update({ where: { id: e.id }, data: base });
  }
  return e;
}

// ---- creation and funding ---------------------------------------------------------------------------------------------

function participantRole(e: Pick<EscrowAgreement, "buyerBusinessId" | "sellerBusinessId">, actor: Actor): "buyer" | "seller" | null {
  return e.buyerBusinessId === actor.businessId ? "buyer" : e.sellerBusinessId === actor.businessId ? "seller" : null;
}

async function ensureCollect(e: EscrowAgreement, buyerName?: string): Promise<EscrowAgreement> {
  if (e.status !== "created" && !(e.status === "awaiting_funding" && !e.checkoutUrl)) return e;
  const partner = getEscrowPartner(e.partner as never);
  const res = await partner.createCollect({
    escrowId: e.id, orderId: e.orderId, amountPaise: num(e.amountPaise), buyer: { businessId: e.buyerBusinessId, name: buyerName },
    expiresAt: e.fundingExpiresAt ?? new Date(Date.now() + fundingTtlHours() * 3_600_000),
  });
  return prisma.$transaction(async (tx) => {
    const cur = await lockEscrow(tx, e.id);
    if (cur.status !== "created" && cur.status !== "awaiting_funding") return cur;
    return setStatus(tx, cur, "awaiting_funding", { partnerRef: res.partnerRef, checkoutUrl: res.checkoutUrl });
  });
}

/**
 * Opens (or resumes) the escrow for an order the actor bought: creates the agreement, asks the partner for a collect
 * link and returns the view. Optional per deal (ADR-012). Idempotent per order.
 */
export async function createEscrowForOrder(actor: Actor, orderId: string): Promise<EscrowView> {
  assertEscrowEnabled();
  const order = await getOrder(actor, orderId);
  if (!order || order.role !== "buyer") throw new DomainError("not_found", "Order not found");
  const existing = await prisma.escrowAgreement.findUnique({ where: { orderId } });
  if (existing && existing.status !== "cancelled") return viewOf(await ensureCollect(existing, order.counterparty.name), "buyer");
  if (!(ESCROWABLE_ORDER_STATUSES as readonly string[]).includes(order.status)) throw new DomainError("conflict", `An order that is ${order.status} can no longer be paid through escrow.`);
  if (order.totalPaise === null || order.totalPaise < minAmountPaise()) throw new DomainError("validation", "This order has no recorded total, or it is below the escrow minimum.", undefined, "escrow.orderNoRecordedTotalBelow");
  const amount = order.totalPaise;
  const b = feeBreakdown(amount);
  const partnerName = configuredPartnerName();
  const expires = new Date(Date.now() + fundingTtlHours() * 3_600_000);
  const created = await prisma.$transaction(async (tx) => {
    if (existing) {
      const cur = await lockEscrow(tx, existing.id);
      if (cur.status !== "cancelled") return cur;
      return setStatus(tx, cur, "created", { amountPaise: BigInt(amount), feePaise: BigInt(b.feePaise), partner: partnerName, partnerRef: null, checkoutUrl: null, fundingExpiresAt: expires, closedAt: null });
    }
    const row = await tx.escrowAgreement.create({
      data: { orderId, buyerBusinessId: actor.businessId, sellerBusinessId: order.counterparty.businessId, amountPaise: BigInt(amount), feePaise: BigInt(b.feePaise), partner: partnerName, fundingExpiresAt: expires },
    });
    await emit(tx, "EscrowCreated", { type: "escrow", id: row.id }, {
      escrowId: row.id, orderId, buyerBusinessId: row.buyerBusinessId, sellerBusinessId: row.sellerBusinessId, amountPaise: amount, feePaise: b.feePaise, partner: partnerName,
    });
    return row;
  });
  // Orders already past confirmation carry their earlier milestones into the new escrow.
  if (order.status === "confirmed") await prisma.$transaction(async (tx) => void (await stamp(tx, await lockEscrow(tx, created.id), "confirmed", "order_event")));
  return viewOf(await ensureCollect(created, order.counterparty.name), "buyer");
}

export type FundingOutcome = "funded" | "duplicate" | "amount_mismatch" | "late_funding" | "ignored";

/** Partner confirmed the buyer's payment: journal the money into buyer_escrow and open the release clock if already delivered. */
export async function applyFundingTx(tx: Tx, escrowId: string, amountPaise: number, partnerRef: string | null): Promise<FundingOutcome> {
  const e = await lockEscrow(tx, escrowId);
  const status = e.status as EscrowStatus;
  if (isHolding(status) || status === "released" || status === "refunded") return "duplicate";
  if (status === "cancelled") {
    await openIssue(tx, { dedupeKey: `late_funding:${e.id}:${amountPaise}`, kind: "late_funding", escrowId: e.id, partnerRef, expectedPaise: 0, actualPaise: amountPaise, detail: "Payment received after the escrow was cancelled or lapsed; refund the buyer." });
    return "late_funding";
  }
  if (amountPaise !== num(e.amountPaise)) {
    await openIssue(tx, { dedupeKey: `funding_amount_mismatch:${e.id}:${amountPaise}`, kind: "funding_amount_mismatch", escrowId: e.id, partnerRef, expectedPaise: num(e.amountPaise), actualPaise: amountPaise, detail: "Partner collected an amount different from the escrow amount; escrow not funded." });
    return "amount_mismatch";
  }
  await postJournal(tx, {
    key: `fund:${e.id}`, kind: "fund", escrowId: e.id, memo: `Buyer funded escrow for order ${e.orderId}`,
    lines: [{ account: ACCOUNTS.nodal, debitPaise: amountPaise }, { account: ACCOUNTS.escrow(e.orderId), creditPaise: amountPaise }],
  });
  let row = await setStatus(tx, e, "funded", {
    partnerRef: partnerRef ?? e.partnerRef,
    autoReleaseAt: e.deliveredAt && !e.frozen ? new Date(e.deliveredAt.getTime() + autoReleaseDays() * DAY_MS) : null,
  });
  row = (await stamp(tx, row, "funded", "buyer")).row;
  const matchId = (await getOrderParties(e.orderId))?.matchId ?? null; // lead attribution for the ADR-012 conversion gate
  await emit(tx, "EscrowFunded", { type: "escrow", id: e.id }, { escrowId: e.id, orderId: e.orderId, amountPaise, partnerRef: partnerRef ?? e.partnerRef ?? "", matchId });
  return "funded";
}

/**
 * BNPL (ADR-019): the lender paid the escrow amount into the nodal collect account on the buyer's behalf. Same effect as a
 * captured buyer payment. Idempotent (a funded escrow reports "duplicate"). Called by @cnote/credit.
 */
export async function fundEscrowFromLender(escrowId: string, amountPaise: number, ref: string): Promise<FundingOutcome> {
  if (!UUID.test(escrowId)) return "ignored";
  if (!/^[\w:.-]{1,120}$/.test(ref)) throw new DomainError("validation", "Invalid lender reference.", undefined, "escrow.invalidLenderReference");
  return prisma.$transaction((tx) => applyFundingTx(tx, escrowId, amountPaise, `lender:${ref}`));
}

/**
 * Invoice financing (ADR-019): record (or update) that this escrow's seller proceeds are assigned to a lender up to
 * `duePaise`. Called by @cnote/credit at disbursal and whenever the outstanding amount changes; `duePaise = 0` clears it.
 * Refused once the escrow has released or refunded everything (nothing left to assign).
 */
export async function setEscrowLenderAssignment(i: { escrowId: string; assignmentId: string; partner: string; partnerLoanRef: string; duePaise: number }): Promise<void> {
  if (!UUID.test(i.escrowId)) throw new DomainError("not_found", "Escrow not found");
  if (!Number.isSafeInteger(i.duePaise) || i.duePaise < 0) throw new DomainError("validation", "Amounts must be whole paise.");
  await prisma.$transaction(async (tx) => {
    const e = await lockEscrow(tx, i.escrowId);
    if (i.duePaise > 0 && !isHolding(e.status as EscrowStatus) && e.status !== "awaiting_funding") throw new DomainError("conflict", `Escrow is ${e.status}: its proceeds can no longer be assigned.`);
    const data = { assignmentId: i.assignmentId, partner: i.partner, partnerLoanRef: i.partnerLoanRef, duePaise: BigInt(i.duePaise), status: i.duePaise > 0 ? "active" : "cleared" };
    await tx.escrowLenderAssignment.upsert({ where: { escrowId: i.escrowId }, create: { escrowId: i.escrowId, ...data }, update: data });
  });
}

// ---- buyer acceptance -----------------------------------------------------------------------------------------------

/** Buyer accepts delivery: records delivered + accepted and releases the held funds to the seller (less fee). */
export async function acceptDelivery(actor: Actor, orderId: string): Promise<EscrowView> {
  assertEscrowEnabled();
  if (!UUID.test(orderId)) throw new DomainError("not_found", "Order not found");
  const e0 = await prisma.escrowAgreement.findUnique({ where: { orderId } });
  if (!e0 || e0.buyerBusinessId !== actor.businessId) throw new DomainError("not_found", "Escrow not found");
  if (e0.status === "released") return viewOf(e0, "buyer");
  if (e0.status !== "funded") throw new DomainError("conflict", "Only a funded escrow can be released.");
  if (e0.frozen) throw new DomainError("conflict", "This escrow is frozen while a dispute is open.");
  const order = await getOrder(actor, orderId);
  if (!order) throw new DomainError("not_found", "Order not found");
  if (order.status === "dispatched") await transitionOrder(actor, orderId, "delivered");
  else if (order.status !== "delivered" && order.status !== "completed") throw new DomainError("conflict", "The seller has not dispatched this order yet.");
  const feeParty = await feeRecipient(e0.sellerBusinessId);
  const row = await prisma.$transaction(async (tx) => {
    let e = await lockEscrow(tx, e0.id);
    if (e.status === "released") return e;
    if (e.status !== "funded") throw new DomainError("conflict", "Only a funded escrow can be released.");
    if (e.frozen) throw new DomainError("conflict", "This escrow is frozen while a dispute is open.");
    e = (await stamp(tx, e, "delivered", "buyer")).row;
    e = (await stamp(tx, e, "accepted", "buyer")).row;
    e = await setStatus(tx, e, "accepted");
    return settleTx(tx, e, { releasePaise: heldOf(e), refundPaise: 0, releaseCause: "buyer_accepted", source: "buyer", feeParty });
  });
  return viewOf(row, "buyer");
}

// ---- event-driven transitions (worker handlers) -----------------------------------------------------------------------

const closeUnfunded = async (tx: Tx, e: EscrowAgreement, cause: "cancelled" | "funding_expired"): Promise<EscrowAgreement> => {
  const row = await setStatus(tx, e, "cancelled", { closedAt: new Date(), autoReleaseAt: null });
  await emit(tx, "EscrowRefunded", { type: "escrow", id: e.id }, { escrowId: e.id, orderId: e.orderId, buyerBusinessId: e.buyerBusinessId, amountPaise: 0, cause });
  return row;
};

/** Order lifecycle drives escrow milestones (confirmed/dispatched/delivered), completion = accepted, cancellation = refund. Idempotent. */
export async function onOrderStatusChanged(p: { orderId: string; to: string }): Promise<void> {
  const found = await prisma.escrowAgreement.findUnique({ where: { orderId: p.orderId }, select: { id: true, status: true, sellerBusinessId: true } });
  if (!found || isTerminal(found.status as EscrowStatus)) return;
  const feeParty = p.to === "completed" ? await feeRecipient(found.sellerBusinessId) : null;
  await prisma.$transaction(async (tx) => {
    let e = await lockEscrow(tx, found.id);
    if (isTerminal(e.status as EscrowStatus)) return;
    if (p.to === "cancelled") {
      if (isHolding(e.status as EscrowStatus)) {
        if (e.frozen) return; // the dispute decides
        await settleTx(tx, e, { releasePaise: 0, refundPaise: heldOf(e), refundCause: "cancelled", source: "system" });
      } else await closeUnfunded(tx, e, "cancelled");
      return;
    }
    const m = milestoneForOrderStatus(p.to);
    if (!m) return;
    if (m === "accepted") {
      e = (await stamp(tx, e, "delivered", "order_event")).row;
      e = (await stamp(tx, e, "accepted", "order_event")).row;
      if (e.status === "funded" && !e.frozen) {
        e = await setStatus(tx, e, "accepted");
        await settleTx(tx, e, { releasePaise: heldOf(e), refundPaise: 0, releaseCause: "buyer_accepted", source: "buyer", feeParty });
      }
      return;
    }
    const r = await stamp(tx, e, m, "order_event");
    if (m === "delivered" && r.isNew && isHolding(r.row.status as EscrowStatus) && !r.row.frozen) {
      await tx.escrowAgreement.update({ where: { id: e.id }, data: { autoReleaseAt: new Date(Date.now() + autoReleaseDays() * DAY_MS) } });
    }
  });
}

/**
 * The seller recorded a credit note for a return (docs/design/grn-returns.md): refund up to the credited amount from the funds still held,
 * to the buyer. Idempotent per credit note (escrow_return_refunds). While a dispute freezes the escrow nothing moves and an ops issue is
 * opened instead; once funds are released the credit only reduces the invoice payable (money is settled off-platform).
 */
export async function onReturnCreditNote(p: { creditNoteId: string; orderId: string; totalPaise: number }): Promise<void> {
  const found = await prisma.escrowAgreement.findUnique({ where: { orderId: p.orderId }, select: { id: true, status: true } });
  if (!found || !isHolding(found.status as EscrowStatus)) return;
  await prisma.$transaction(async (tx) => {
    const e = await lockEscrow(tx, found.id);
    if (!isHolding(e.status as EscrowStatus)) return;
    if (await tx.escrowReturnRefund.findUnique({ where: { creditNoteId: p.creditNoteId } })) return;
    if (e.frozen) {
      await openIssue(tx, { dedupeKey: `return_credit_frozen:${p.creditNoteId}`, kind: "return_credit_frozen", escrowId: e.id, expectedPaise: p.totalPaise, detail: "A return credit note was recorded while a dispute froze the escrow; decide the refund with the dispute." });
      return;
    }
    const refund = Math.max(0, Math.min(p.totalPaise, heldOf(e)));
    await tx.escrowReturnRefund.create({ data: { creditNoteId: p.creditNoteId, escrowId: e.id, amountPaise: BigInt(refund) } });
    if (refund > 0) await settleTx(tx, e, { releasePaise: 0, refundPaise: refund, refundCause: "return_credit", source: "system" });
  });
}

/** Dispute opened on an order with an escrow: freeze (overlay) so nothing auto-releases. Idempotent per dispute. */
export async function onDisputeOpened(p: { disputeId: string; orderId: string }): Promise<void> {
  const found = await prisma.escrowAgreement.findUnique({ where: { orderId: p.orderId }, select: { id: true, status: true } });
  if (!found || isTerminal(found.status as EscrowStatus)) return;
  await prisma.$transaction(async (tx) => {
    const e = await lockEscrow(tx, found.id);
    if (isTerminal(e.status as EscrowStatus)) return;
    const r = await tx.escrowFreeze.createMany({ data: [{ escrowId: e.id, disputeId: p.disputeId }], skipDuplicates: true });
    if (r.count === 0) return;
    await tx.escrowAgreement.update({ where: { id: e.id }, data: { frozen: true } });
    await emit(tx, "EscrowFrozen", { type: "escrow", id: e.id }, { escrowId: e.id, orderId: e.orderId, disputeId: p.disputeId });
  });
}

/**
 * Dispute resolved: lift the freeze and move funds per the decision (refund to buyer, release to seller, or both).
 * Amounts are clamped to what is held. With nothing to move (withdrawn) the escrow just resumes and its auto-release
 * clock restarts. While another dispute is still open the overlay stays and no money moves.
 */
export async function onDisputeResolved(p: { disputeId: string; refundPaise: number; releasePaise: number }): Promise<void> {
  const fr = await prisma.escrowFreeze.findUnique({ where: { disputeId: p.disputeId } });
  if (!fr || fr.resolvedAt) return;
  const seller = await prisma.escrowAgreement.findUnique({ where: { id: fr.escrowId }, select: { sellerBusinessId: true } });
  const feeParty = seller && p.releasePaise > 0 ? await feeRecipient(seller.sellerBusinessId) : null;
  await prisma.$transaction(async (tx) => {
    let e = await lockEscrow(tx, fr.escrowId);
    const cur = await tx.escrowFreeze.findUniqueOrThrow({ where: { disputeId: p.disputeId } });
    if (cur.resolvedAt) return;
    await tx.escrowFreeze.update({ where: { id: cur.id }, data: { resolvedAt: new Date() } });
    const open = await tx.escrowFreeze.count({ where: { escrowId: e.id, resolvedAt: null } });
    if (open > 0) {
      await emit(tx, "EscrowUnfrozen", { type: "escrow", id: e.id }, { escrowId: e.id, orderId: e.orderId, disputeId: p.disputeId });
      return;
    }
    e = await tx.escrowAgreement.update({ where: { id: e.id }, data: { frozen: false } });
    await emit(tx, "EscrowUnfrozen", { type: "escrow", id: e.id }, { escrowId: e.id, orderId: e.orderId, disputeId: p.disputeId });
    if (!isHolding(e.status as EscrowStatus)) return;
    const held = heldOf(e);
    const refund = Math.max(0, Math.min(p.refundPaise, held));
    const release = Math.max(0, Math.min(p.releasePaise, held - refund));
    if (refund + release > 0) {
      e = await settleTx(tx, e, { releasePaise: release, refundPaise: refund, releaseCause: "dispute_resolution", refundCause: "dispute_resolution", allowFrozen: true, source: "dispute", feeParty });
    }
    if (isHolding(e.status as EscrowStatus) && e.deliveredAt) {
      await tx.escrowAgreement.update({ where: { id: e.id }, data: { autoReleaseAt: new Date(Date.now() + autoReleaseDays() * DAY_MS) } });
    }
  });
}

// ---- scheduled sweeps ------------------------------------------------------------------------------------------------

/** Releases every funded, delivered, un-frozen escrow whose auto-release time has passed. Never touches a frozen escrow. */
export async function runAutoRelease(now: Date = new Date()): Promise<number> {
  const due = await prisma.escrowAgreement.findMany({
    where: { frozen: false, OR: [{ status: "funded", autoReleaseAt: { lte: now }, deliveredAt: { not: null } }, { status: "accepted" }] },
    select: { id: true, sellerBusinessId: true }, take: 200,
  });
  let n = 0;
  for (const d of due) {
    try {
      const feeParty = await feeRecipient(d.sellerBusinessId);
      const done = await prisma.$transaction(async (tx) => {
        let e = await lockEscrow(tx, d.id);
        const st = e.status as EscrowStatus;
        const eligible = !e.frozen && ((st === "funded" && !!e.autoReleaseAt && e.autoReleaseAt <= now && !!e.deliveredAt) || st === "accepted");
        if (!eligible) return false;
        if (st === "funded") e = await setStatus(tx, e, "accepted");
        await settleTx(tx, e, { releasePaise: heldOf(e), refundPaise: 0, releaseCause: "auto_release", source: "system", feeParty });
        return true;
      });
      if (done) n++;
    } catch (err) {
      console.error("[escrow] auto-release failed", d.id, err);
    }
  }
  return n;
}

/** Closes escrows the buyer never funded in time (no money involved). */
export async function expireUnfunded(now: Date = new Date()): Promise<number> {
  const due = await prisma.escrowAgreement.findMany({ where: { status: { in: ["created", "awaiting_funding"] }, fundingExpiresAt: { lte: now } }, select: { id: true }, take: 200 });
  let n = 0;
  for (const d of due) {
    const done = await prisma.$transaction(async (tx) => {
      const e = await lockEscrow(tx, d.id);
      if (e.status !== "created" && e.status !== "awaiting_funding") return false;
      await closeUnfunded(tx, e, "funding_expired");
      return true;
    });
    if (done) n++;
  }
  return n;
}

// ---- staff (escrow.manage; callers wrap in audited()) --------------------------------------------------------------------

async function staffSettle(escrowId: string, kind: "release" | "refund"): Promise<EscrowView> {
  if (!UUID.test(escrowId)) throw new DomainError("not_found", "Escrow not found");
  const e0 = await prisma.escrowAgreement.findUnique({ where: { id: escrowId } });
  if (!e0) throw new DomainError("not_found", "Escrow not found");
  const feeParty = kind === "release" ? await feeRecipient(e0.sellerBusinessId) : null;
  const row = await prisma.$transaction(async (tx) => {
    const e = await lockEscrow(tx, escrowId);
    const held = heldOf(e);
    if (held <= 0) throw new DomainError("conflict", "No funds are held for this escrow.");
    return kind === "release"
      ? settleTx(tx, e, { releasePaise: held, refundPaise: 0, releaseCause: "staff", source: "staff", feeParty })
      : settleTx(tx, e, { releasePaise: 0, refundPaise: held, refundCause: "staff", source: "staff" });
  });
  return viewOf(row, "buyer");
}
/** Manual release of everything held to the seller. Refused while frozen. */
export const staffReleaseEscrow = (escrowId: string): Promise<EscrowView> => staffSettle(escrowId, "release");
/** Manual refund of everything held to the buyer. Refused while frozen. */
export const staffRefundEscrow = (escrowId: string): Promise<EscrowView> => staffSettle(escrowId, "refund");

// ---- reads -----------------------------------------------------------------------------------------------------------------

/** The escrow for an order, for a participant only (else null). Also carries the fee quote when none exists yet. */
export async function getEscrowForOrder(actor: Actor, orderId: string): Promise<EscrowView | null> {
  if (!UUID.test(orderId)) return null;
  const e = await prisma.escrowAgreement.findUnique({ where: { orderId } });
  const role = e ? participantRole(e, actor) : null;
  return e && role ? viewOf(e, role) : null;
}

/** System read (no actor) for trusted server-side callers such as the disputes brief: status, frozen and funds held. */
export async function getEscrowSnapshotForOrder(orderId: string): Promise<{ escrowId: string; status: string; frozen: boolean; heldPaise: number } | null> {
  if (!UUID.test(orderId)) return null;
  const e = await prisma.escrowAgreement.findUnique({ where: { orderId } });
  return e ? { escrowId: e.id, status: e.status, frozen: e.frozen, heldPaise: heldOf(e) } : null;
}

export interface EscrowOffer { enabled: boolean; eligible: boolean; nudge: boolean; quote: FeeQuote | null }

/** Whether the buyer can open an escrow for this order, whether to nudge (first-time counterparties) and the fee disclosure. */
export async function getEscrowOffer(actor: Actor, order: Pick<OrderView, "id" | "status" | "role" | "totalPaise" | "counterparty">): Promise<EscrowOffer> {
  const enabled = escrowEnabled();
  const eligible = enabled && order.role === "buyer" && (ESCROWABLE_ORDER_STATUSES as readonly string[]).includes(order.status) && order.totalPaise !== null && order.totalPaise >= minAmountPaise();
  return {
    enabled, eligible,
    nudge: eligible ? await shouldNudgeEscrow(actor.businessId, order.counterparty.businessId) : false,
    quote: eligible ? quoteEscrow(order.totalPaise!) : null,
  };
}

/** Escrow is strongly nudged for first-time counterparties: true when the pair has no completed order together (ADR-012). */
export async function shouldNudgeEscrow(buyerId: string, sellerId: string): Promise<boolean> {
  let cursor: string | null = null;
  for (let i = 0; i < 10; i++) {
    const page = await listOrders(system(buyerId), { role: "buyer", cursor });
    if (page.items.some((o) => o.counterparty.businessId === sellerId && o.status === "completed")) return false;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return true;
}

export interface EscrowRow { id: string; orderId: string; status: string; frozen: boolean; amountPaise: number; heldPaise: number; buyerBusinessId: string; sellerBusinessId: string; partner: string; createdAt: string }
const rowOf = (e: EscrowAgreement): EscrowRow => ({
  id: e.id, orderId: e.orderId, status: e.status, frozen: e.frozen, amountPaise: num(e.amountPaise), heldPaise: heldOf(e),
  buyerBusinessId: e.buyerBusinessId, sellerBusinessId: e.sellerBusinessId, partner: e.partner, createdAt: e.createdAt.toISOString(),
});

export async function listEscrows(opts: { status?: string; frozen?: boolean; limit?: number } = {}): Promise<EscrowRow[]> {
  const rows = await prisma.escrowAgreement.findMany({
    where: { ...(opts.status ? { status: opts.status } : {}), ...(opts.frozen !== undefined ? { frozen: opts.frozen } : {}) },
    orderBy: { createdAt: "desc" }, take: Math.min(opts.limit ?? 100, 200),
  });
  return rows.map(rowOf);
}

export interface EscrowDetail extends EscrowRow {
  feePaise: number; feeChargedPaise: number; releasedPaise: number; refundedPaise: number; partnerRef: string | null; feeInvoiceId: string | null;
  milestones: { milestone: string; source: string; at: string }[];
  payouts: { id: string; kind: string; status: string; amountPaise: number; partnerRef: string | null; attempts: number; lastError: string | null; requestedAt: string; settledAt: string | null; latencyMs: number | null }[];
  freezes: { disputeId: string; openedAt: string; resolvedAt: string | null }[];
}

export async function getEscrowDetail(id: string): Promise<EscrowDetail | null> {
  if (!UUID.test(id)) return null;
  const e = await prisma.escrowAgreement.findUnique({ where: { id }, include: { payouts: { orderBy: { requestedAt: "asc" } }, freezes: { orderBy: { openedAt: "asc" } } } });
  if (!e) return null;
  const ms = await prisma.escrowMilestone.findMany({ where: { escrowId: id }, orderBy: { at: "asc" } });
  return {
    ...rowOf(e), feePaise: num(e.feePaise), feeChargedPaise: num(e.feeChargedPaise), releasedPaise: num(e.releasedPaise), refundedPaise: num(e.refundedPaise),
    partnerRef: e.partnerRef, feeInvoiceId: e.feeInvoiceId,
    milestones: ms.map((m) => ({ milestone: m.milestone, source: m.source, at: m.at.toISOString() })),
    payouts: e.payouts.map((p) => ({ id: p.id, kind: p.kind, status: p.status, amountPaise: num(p.amountPaise), partnerRef: p.partnerRef, attempts: p.attempts, lastError: p.lastError, requestedAt: p.requestedAt.toISOString(), settledAt: p.settledAt?.toISOString() ?? null, latencyMs: p.latencyMs })),
    freezes: e.freezes.map((f) => ({ disputeId: f.disputeId, openedAt: f.openedAt.toISOString(), resolvedAt: f.resolvedAt?.toISOString() ?? null })),
  };
}
export { HOLDING_STATUSES };
