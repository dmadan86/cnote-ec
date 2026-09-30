// Loan-book mirror (the partner is lender of record): disbursal, repayments, overdue tracking (DPD), invoice-financing assignment.
import { emit } from "@cnote/core";
import { prisma, type CreditLoan, type Tx } from "@cnote/db";
import { DAY_MS } from "./config";
import { getCreditPartner } from "./partner";
import { ports } from "./ports";
import type { Product } from "./types";
import { num, outstandingOf } from "./views";

export const DPD_BUCKETS = [90, 60, 30, 1] as const;
export const bucketOf = (dpd: number): number => DPD_BUCKETS.find((b) => dpd >= b) ?? 0;
/** Days past due (0 when not yet due). Day 1 starts 24h after the due instant. */
export const dpdOf = (dueAt: Date, now: Date): number => Math.max(0, Math.floor((now.getTime() - dueAt.getTime()) / DAY_MS));

export interface DisbursedInput { partner: string; partnerRef: string; loanRef: string; amountPaise?: number; at: Date }

/** Create the loan for an accepted application (idempotent). Returns the loan and whether it was newly created. */
export async function recordDisbursal(tx: Tx, i: DisbursedInput): Promise<{ loan: CreditLoan; created: boolean } | null> {
  const app = await tx.creditApplication.findUnique({ where: { partner_partnerRef: { partner: i.partner, partnerRef: i.partnerRef } } });
  if (!app) return null;
  const existing = await tx.creditLoan.findUnique({ where: { applicationId: app.id } });
  if (existing) return { loan: existing, created: false };
  const offer = app.acceptedOfferId ? await tx.creditOffer.findUnique({ where: { id: app.acceptedOfferId } }) : null;
  if (!offer) return null; // a disbursal without an explicit acceptance is never mirrored as ours
  const principal = i.amountPaise ?? num(offer.amountPaise);
  const loan = await tx.creditLoan.create({
    data: {
      applicationId: app.id, businessId: app.businessId, product: app.product, escrowId: app.escrowId, orderId: app.orderId, orderAmountPaise: app.orderAmountPaise, partner: i.partner,
      partnerLoanRef: i.loanRef, principalPaise: BigInt(principal), aprBps: offer.aprBps, tenorDays: offer.tenorDays, totalRepayablePaise: offer.totalRepayablePaise,
      disbursedAt: i.at, dueAt: new Date(i.at.getTime() + offer.tenorDays * DAY_MS), status: "active",
    },
  });
  await tx.creditApplication.update({ where: { id: app.id }, data: { status: "disbursed", closedAt: null } });
  if (app.product === "invoice_financing") {
    await tx.creditAssignment.create({ data: { loanId: loan.id, escrowId: app.escrowId, orderId: app.orderId, sellerBusinessId: app.businessId, partner: i.partner, status: "active" } });
  }
  await emit(tx, "CreditDisbursed", { type: "credit_loan", id: loan.id }, { loanId: loan.id, applicationId: app.id, businessId: app.businessId, amountPaise: principal, orderId: app.orderId });
  return { loan, created: true };
}

export interface RepaymentInput { eventKey: string; amountPaise: number; source: string; paidAt: Date }

/** Idempotent per (loan, eventKey). Closes the loan when fully repaid. Returns false for a replay. */
export async function recordRepayment(tx: Tx, loanId: string, r: RepaymentInput): Promise<boolean> {
  const made = await tx.creditRepayment.createMany({ skipDuplicates: true, data: [{ loanId, eventKey: r.eventKey, amountPaise: BigInt(r.amountPaise), source: r.source, paidAt: r.paidAt }] });
  if (made.count === 0) return false;
  const loan = await tx.creditLoan.update({ where: { id: loanId }, data: { repaidPaise: { increment: BigInt(r.amountPaise) } } });
  const outstanding = outstandingOf(loan);
  await emit(tx, "CreditRepaid", { type: "credit_loan", id: loanId }, { loanId, amountPaise: r.amountPaise, outstandingPaise: outstanding });
  if (outstanding === 0 && loan.status !== "repaid" && loan.status !== "written_off" && loan.status !== "cancelled") {
    await tx.creditLoan.update({ where: { id: loanId }, data: { status: "repaid", dpd: 0, closedAt: r.paidAt } });
    await tx.creditAssignment.updateMany({ where: { loanId, status: { in: ["active", "released"] } }, data: { status: "settled" } });
    await emit(tx, "CreditClosed", { type: "credit_loan", id: loanId }, { loanId, businessId: loan.businessId, status: "repaid" });
  }
  return true;
}

/**
 * Cancellation of a disbursed loan (borrower cooling-off exit, or the partner cancelling): the mirror closes as `cancelled`, the
 * application is closed, the assignment cancelled and CreditCancelled emitted. Idempotent: false when the loan is not open.
 */
export async function recordCancellation(tx: Tx, loanId: string, i: { reason: "cooling_off" | "partner"; at: Date; exitAmountPaise?: number | null }): Promise<boolean> {
  const done = await tx.creditLoan.updateMany({
    where: { id: loanId, status: { in: ["active", "overdue"] } },
    data: { status: "cancelled", dpd: 0, closedAt: i.at, cancelReason: i.reason, exitAmountPaise: i.exitAmountPaise == null ? null : BigInt(i.exitAmountPaise) },
  });
  if (done.count === 0) return false;
  const loan = await tx.creditLoan.findUniqueOrThrow({ where: { id: loanId } });
  await tx.creditApplication.update({ where: { id: loan.applicationId }, data: { status: "cancelled", reason: i.reason === "cooling_off" ? "cooling_off_exit" : "cancelled_by_partner", closedAt: i.at } });
  await tx.creditAssignment.updateMany({ where: { loanId, status: { in: ["active", "released"] } }, data: { status: "cancelled" } });
  await emit(tx, "CreditCancelled", { type: "credit_loan", id: loanId }, { loanId, applicationId: loan.applicationId, businessId: loan.businessId, reason: i.reason });
  return true;
}

export async function recordWriteOff(tx: Tx, loanId: string, at: Date): Promise<void> {
  const loan = await tx.creditLoan.findUnique({ where: { id: loanId } });
  if (!loan || loan.status === "repaid" || loan.status === "written_off" || loan.status === "cancelled") return;
  await tx.creditLoan.update({ where: { id: loanId }, data: { status: "written_off", writtenOffPaise: BigInt(outstandingOf(loan)), closedAt: at } });
  await tx.creditAssignment.updateMany({ where: { loanId, status: { in: ["active", "released"] } }, data: { status: "cancelled" } });
  await emit(tx, "CreditClosed", { type: "credit_loan", id: loanId }, { loanId, businessId: loan.businessId, status: "written_off" });
}

/** Apply a DPD value; emits CreditOverdue when it crosses into a higher bucket (1, 30, 60, 90). */
export async function applyDpd(tx: Tx, loan: CreditLoan, dpd: number): Promise<boolean> {
  if (loan.status === "repaid" || loan.status === "written_off" || loan.status === "cancelled") return false;
  const next = Math.max(loan.dpd, dpd);
  if (next === loan.dpd && loan.status === (next > 0 ? "overdue" : "active")) return false;
  const bucket = bucketOf(next);
  await tx.creditLoan.update({ where: { id: loan.id }, data: { dpd: next, status: next > 0 ? "overdue" : "active", lastDpdBucket: Math.max(bucket, loan.lastDpdBucket) } });
  if (bucket > loan.lastDpdBucket) await emit(tx, "CreditOverdue", { type: "credit_loan", id: loan.id }, { loanId: loan.id, businessId: loan.businessId, dpd: next });
  return true;
}

/** Scheduled: recompute DPD from due dates for every open loan with an outstanding balance (independent of partner reports). */
export async function updateDpd(now = new Date(), limit = 1000): Promise<{ updated: number }> {
  const rows = await prisma.creditLoan.findMany({ where: { status: { in: ["active", "overdue"] }, dueAt: { lt: now } }, take: limit });
  let updated = 0;
  for (const l of rows) {
    if (outstandingOf(l) === 0) continue;
    const changed = await prisma.$transaction((tx) => applyDpd(tx, l, dpdOf(l.dueAt, now)));
    if (changed) updated += 1;
  }
  return { updated };
}

/** Offers past their expiry become `expired`; applications with no open offer left expire with them. */
export async function expireOffers(now = new Date()): Promise<{ offers: number; applications: number }> {
  const stale = await prisma.creditOffer.findMany({ where: { status: "open", expiresAt: { lt: now } }, select: { id: true, applicationId: true } });
  if (stale.length === 0) return { offers: 0, applications: 0 };
  return prisma.$transaction(async (tx) => {
    await tx.creditOffer.updateMany({ where: { id: { in: stale.map((s) => s.id) }, status: "open" }, data: { status: "expired" } });
    const appIds = [...new Set(stale.map((s) => s.applicationId))];
    let applications = 0;
    for (const id of appIds) {
      if ((await tx.creditOffer.count({ where: { applicationId: id, status: "open" } })) > 0) continue;
      const r = await tx.creditApplication.updateMany({ where: { id, status: "offered" }, data: { status: "expired", reason: "offer_expired", closedAt: now } });
      applications += r.count;
    }
    return { offers: stale.length, applications };
  });
}

// ---- BNPL funding: the partner pays the escrow; escrow records the funding through its own port ---------------------------

/** For each BNPL loan whose escrow is still unfunded, ask escrow to record funding (idempotent by loan id). */
export async function retryBnplFunding(): Promise<{ attempted: number; funded: number }> {
  const loans = await prisma.creditLoan.findMany({ where: { product: "bnpl", status: { in: ["active", "overdue"] } }, orderBy: { disbursedAt: "desc" }, take: 200 });
  let attempted = 0, funded = 0;
  for (const l of loans) {
    const facts = await ports().escrowFacts(l.escrowId);
    if (!facts || (facts.status !== "created" && facts.status !== "awaiting_funding")) continue;
    attempted += 1;
    try {
      if (await ports().fundEscrowFromLender(l.escrowId, num(l.principalPaise), l.id)) funded += 1;
    } catch (err) {
      console.error("[credit] bnpl escrow funding failed", l.id, err);
    }
  }
  return { attempted, funded };
}

// ---- Invoice-financing assignment: contract with @cnote/escrow ---------------------------------------------------------------

export interface PayoutAssignment {
  assignmentId: string;
  loanId: string;
  partner: string;
  partnerLoanRef: string;
  lenderName: string;
  /** what the partner is still owed; escrow pays min(sellerNet, this) to the partner BEFORE the seller */
  dueToPartnerPaise: number;
}

/** Called by escrow when it creates the seller payout for a release. Null when the escrow has no live assignment. */
export async function getPayoutAssignmentForEscrow(escrowId: string): Promise<PayoutAssignment | null> {
  const a = await prisma.creditAssignment.findUnique({ where: { escrowId } });
  if (!a || (a.status !== "active" && a.status !== "released")) return null;
  const loan = await prisma.creditLoan.findUnique({ where: { id: a.loanId } });
  if (!loan || outstandingOf(loan) === 0) return null;
  return { assignmentId: a.id, loanId: loan.id, partner: a.partner, partnerLoanRef: loan.partnerLoanRef, lenderName: getCreditPartner(a.partner).lender.name, dueToPartnerPaise: outstandingOf(loan) };
}

/** Called by escrow once its transfer to the partner settled. Idempotent by `reference` (the escrow payout id). */
export async function recordAssignmentSettlement(i: { assignmentId: string; amountPaise: number; reference: string; at?: Date }): Promise<{ recorded: boolean }> {
  const a = await prisma.creditAssignment.findUnique({ where: { id: i.assignmentId } });
  if (!a) return { recorded: false };
  const recorded = await prisma.$transaction((tx) => recordRepayment(tx, a.loanId, { eventKey: `escrow:${i.reference}`, amountPaise: i.amountPaise, source: "escrow_release", paidAt: i.at ?? new Date() }));
  return { recorded };
}

/** EscrowReleased: mark the assignment as awaiting settlement (escrow will pay the partner first). */
export async function onEscrowReleased(escrowId: string): Promise<void> {
  await prisma.creditAssignment.updateMany({ where: { escrowId, status: "active" }, data: { status: "released" } });
}

/** EscrowRefunded: when the escrow is fully refunded there is no release to recover from; the seller repays the partner directly. */
export async function onEscrowRefunded(escrowId: string): Promise<void> {
  const facts = await ports().escrowFacts(escrowId);
  if (facts?.status === "refunded") await prisma.creditAssignment.updateMany({ where: { escrowId, status: "active" }, data: { status: "cancelled" } });
}

export type { Product };

/**
 * Keeps escrow's record of the lender's claim on an invoice-financed escrow in step with the loan (idempotent upsert):
 * due = outstanding while the loan is open, 0 once it is repaid, written off or the assignment is cancelled. Run on
 * CreditDisbursed / CreditRepaid / CreditClosed. Escrow refuses new claims on an escrow that has already paid out.
 */
export async function syncEscrowAssignment(loanId: string): Promise<"synced" | "none" | "refused"> {
  const a = await prisma.creditAssignment.findFirst({ where: { loanId } });
  const loan = a ? await prisma.creditLoan.findUnique({ where: { id: loanId } }) : null;
  if (!a || !loan || !a.escrowId) return "none";
  const open = (a.status === "active" || a.status === "released") && loan.status !== "repaid" && loan.status !== "written_off" && loan.status !== "cancelled";
  try {
    await ports().assignEscrowProceeds({ escrowId: a.escrowId, assignmentId: a.id, partner: a.partner, partnerLoanRef: loan.partnerLoanRef, duePaise: open ? outstandingOf(loan) : 0 });
    return "synced";
  } catch (err) {
    if ((err as { code?: string }).code === "conflict") return "refused"; // escrow already paid out: the seller repays the lender directly
    throw err;
  }
}
