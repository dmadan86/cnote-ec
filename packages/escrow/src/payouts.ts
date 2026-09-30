// Transfers out of the nodal account (ADR-012): seller payouts after release, buyer refunds.
// A release/refund decision queues an EscrowPayout; this job asks the partner to move the money (idempotent by payout id)
// and, once the partner confirms (immediately or by webhook), posts the transfer journal and emits PayoutSettled.
import { emit } from "@cnote/core";
import { prisma, type Tx } from "@cnote/db";
import { openIssue } from "./escrow";
import { ACCOUNTS, postJournal } from "./ledger";
import { getEscrowPartner } from "./partner";

const MAX_ATTEMPTS = 8;
const STUCK_MS = 48 * 3_600_000;
const INT_MAX = 2_147_483_647;

export type TransferOutcome = "settled" | "duplicate" | "not_found";

/** Marks a payout settled and posts Dr payable / Cr partner_nodal. Idempotent. Caller supplies the transaction. */
export async function settleTransferTx(tx: Tx, payoutId: string, partnerRef: string | null, at: Date = new Date()): Promise<TransferOutcome> {
  if (!/^[0-9a-f-]{36}$/i.test(payoutId)) return "not_found";
  await tx.$queryRaw`SELECT id FROM escrow_payouts WHERE id = ${payoutId}::uuid FOR UPDATE`;
  const p = await tx.escrowPayout.findUnique({ where: { id: payoutId }, include: { escrow: true } });
  if (!p) return "not_found";
  if (p.status === "settled") return "duplicate";
  const amount = Number(p.amountPaise);
  const seller = p.kind === "seller_payout";
  await postJournal(tx, {
    key: `transfer:${p.id}`, kind: seller ? "payout" : "refund_payout", escrowId: p.escrowId,
    memo: `${seller ? "Payout to seller" : "Refund to buyer"} for order ${p.escrow.orderId}`,
    lines: [
      { account: seller ? ACCOUNTS.sellerPayable(p.businessId) : ACCOUNTS.refundPayable(p.businessId), debitPaise: amount },
      { account: ACCOUNTS.nodal, creditPaise: amount },
    ],
  });
  const latencyMs = Math.min(INT_MAX, Math.max(0, at.getTime() - p.requestedAt.getTime()));
  await tx.escrowPayout.update({ where: { id: p.id }, data: { status: "settled", settledAt: at, latencyMs, partnerRef: partnerRef ?? p.partnerRef, lastError: null } });
  if (seller) {
    await emit(tx, "PayoutSettled", { type: "escrow_payout", id: p.id }, {
      payoutId: p.id, escrowId: p.escrowId, sellerBusinessId: p.businessId, amountPaise: amount, partnerRef: partnerRef ?? p.partnerRef ?? "", latencyMs,
    });
  }
  return "settled";
}

/** Partner reported a failed transfer: back to the queue for retry (attempt counted). */
export async function markTransferFailedTx(tx: Tx, payoutId: string, reason: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(payoutId)) return false;
  const p = await tx.escrowPayout.findUnique({ where: { id: payoutId } });
  if (!p || p.status === "settled") return false;
  await tx.escrowPayout.update({ where: { id: p.id }, data: { submittedAt: null, attempts: { increment: 1 }, lastError: reason.slice(0, 300), status: p.attempts + 1 >= MAX_ATTEMPTS ? "failed" : "pending" } });
  return true;
}

/** Submits queued transfers to the partner. Safe to run concurrently and repeatedly (partner call is idempotent by payout id). */
export async function processPayouts(now: Date = new Date()): Promise<{ submitted: number; settled: number; failed: number }> {
  const out = { submitted: 0, settled: 0, failed: 0 };
  const rows = await prisma.escrowPayout.findMany({ where: { status: "pending", submittedAt: null }, orderBy: { requestedAt: "asc" }, take: 100, include: { escrow: { select: { partner: true } } } });
  for (const p of rows) {
    const partner = getEscrowPartner(p.escrow.partner as never);
    const req = { transferId: p.id, escrowId: p.escrowId, amountPaise: Number(p.amountPaise), beneficiaryBusinessId: p.businessId, purpose: p.kind as "seller_payout" | "buyer_refund" };
    try {
      const res = p.kind === "seller_payout" ? await partner.releasePayout(req) : await partner.refund(req);
      out.submitted++;
      if (res.status === "settled") {
        await prisma.$transaction((tx) => settleTransferTx(tx, p.id, res.partnerRef, new Date()));
        out.settled++;
      } else {
        await prisma.escrowPayout.update({ where: { id: p.id }, data: { submittedAt: now, partnerRef: res.partnerRef, attempts: { increment: 1 } } });
      }
    } catch (err) {
      out.failed++;
      const message = err instanceof Error ? err.message : String(err);
      const attempts = p.attempts + 1;
      await prisma.$transaction(async (tx) => {
        await tx.escrowPayout.update({ where: { id: p.id }, data: { attempts, lastError: message.slice(0, 300), status: attempts >= MAX_ATTEMPTS ? "failed" : "pending" } });
        if (attempts >= MAX_ATTEMPTS) await openIssue(tx, { dedupeKey: `payout_failed:${p.id}`, kind: "payout_failed", escrowId: p.escrowId, expectedPaise: Number(p.amountPaise), detail: `Payout failed after ${attempts} attempts: ${message.slice(0, 200)}` });
      });
    }
  }
  // Submitted long ago but never confirmed: surface for staff instead of waiting forever.
  const stuck = await prisma.escrowPayout.findMany({ where: { status: "pending", submittedAt: { lte: new Date(now.getTime() - STUCK_MS) } }, take: 100 });
  for (const p of stuck) {
    await prisma.$transaction((tx) => openIssue(tx, { dedupeKey: `payout_stuck:${p.id}`, kind: "payout_stuck", escrowId: p.escrowId, partnerRef: p.partnerRef, expectedPaise: Number(p.amountPaise), detail: "Transfer submitted to the partner but not confirmed for over 48 hours." }));
  }
  return out;
}
