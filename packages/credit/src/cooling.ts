// Cooling-off exit (RBI digital lending guidelines, ADR-019): within CREDIT_COOLING_OFF_DAYS of disbursal the borrower may exit
// by repaying the principal plus interest accrued pro rata, with no penalty and no prepayment charge. The disclosure lives in the
// KFS; this makes it operable. The exact amount is shown first, exit needs an explicit confirmation of that amount, the partner
// (lender of record) is asked to cancel, and only then does the mirror close as `cancelled` (CreditCancelled). Deliberately NOT gated
// by CREDIT_ENABLED: a borrower with a live loan can always exit inside the window.
import { DomainError } from "@cnote/core";
import { prisma, type CreditLoan } from "@cnote/db";
import { DAY_MS, creditConfig } from "./config";
import { coolingOffAmount, type CoolingOffAmount } from "./kfs";
import { recordCancellation, syncEscrowAssignment } from "./loans";
import { getCreditPartner } from "./partner";
import type { Actor, LoanView } from "./types";
import { num, toLoanView } from "./views";

const UUID = /^[0-9a-f-]{36}$/i;

export type CoolingOffBlock = "loan_closed" | "window_over" | "escrow_settling";
export interface CoolingOffQuote extends CoolingOffAmount {
  loanId: string;
  product: string;
  lenderName: string;
  eligible: boolean;
  /** why the exit is not available (null when eligible) */
  blocked: CoolingOffBlock | null;
  windowEndsAt: string;
  coolingOffDays: number;
  /** the lender also waives fees on exit (config) */
  feesWaived: boolean;
  /** processing and other fees on the offer (informational; `feesPaise` is what is actually charged on exit) */
  offerFeesPaise: number;
}

async function feesOf(loan: CreditLoan): Promise<number> {
  const app = await prisma.creditApplication.findUnique({ where: { id: loan.applicationId }, select: { acceptedOfferId: true } });
  const offer = app?.acceptedOfferId ? await prisma.creditOffer.findUnique({ where: { id: app.acceptedOfferId }, select: { processingFeePaise: true, otherFeesPaise: true } }) : null;
  return offer ? num(offer.processingFeePaise) + num(offer.otherFeesPaise) : 0;
}

async function ownedLoan(actor: Actor, loanId: string): Promise<CreditLoan> {
  const loan = UUID.test(loanId) ? await prisma.creditLoan.findUnique({ where: { id: loanId } }) : null;
  if (!loan || loan.businessId !== actor.businessId) throw new DomainError("not_found", "Loan not found.");
  return loan;
}

async function quoteFor(loan: CreditLoan, now: Date): Promise<CoolingOffQuote> {
  const cfg = creditConfig();
  const offerFeesPaise = await feesOf(loan);
  const amount = coolingOffAmount(
    { principalPaise: num(loan.principalPaise), aprBps: loan.aprBps, tenorDays: loan.tenorDays, feesPaise: offerFeesPaise, repaidPaise: num(loan.repaidPaise), disbursedAt: loan.disbursedAt },
    now, cfg.coolingOffWaivesFees,
  );
  const windowEnd = new Date(loan.disbursedAt.getTime() + cfg.coolingOffDays * DAY_MS);
  const settling = loan.product === "invoice_financing" && (await prisma.creditAssignment.count({ where: { loanId: loan.id, status: "released" } })) > 0;
  const blocked: CoolingOffBlock | null =
    loan.status !== "active" && loan.status !== "overdue" ? "loan_closed" : now.getTime() > windowEnd.getTime() ? "window_over" : settling ? "escrow_settling" : null;
  let lenderName = loan.partner;
  try { lenderName = getCreditPartner(loan.partner).lender.name; } catch { /* unknown partner: show its id */ }
  return { ...amount, loanId: loan.id, product: loan.product, lenderName, eligible: blocked === null, blocked, windowEndsAt: windowEnd.toISOString(), coolingOffDays: cfg.coolingOffDays, feesWaived: cfg.coolingOffWaivesFees, offerFeesPaise };
}

/** The exact amount the borrower would owe to exit today (and whether the window is still open). */
export async function getCoolingOffQuote(actor: Actor, loanId: string, now = new Date()): Promise<CoolingOffQuote> {
  return quoteFor(await ownedLoan(actor, loanId), now);
}

/** Quotes for the borrower's loans that can still exit (keyed by loan id), for the portal and the BNPL panel. */
export async function coolingOffQuotesFor(actor: Actor, loans: { id: string }[], now = new Date()): Promise<Record<string, CoolingOffQuote>> {
  const out: Record<string, CoolingOffQuote> = {};
  const rows = loans.length ? await prisma.creditLoan.findMany({ where: { id: { in: loans.map((l) => l.id) }, businessId: actor.businessId, status: { in: ["active", "overdue"] } } }) : [];
  for (const l of rows) {
    if (l.disbursedAt.getTime() + creditConfig().coolingOffDays * DAY_MS < now.getTime()) continue;
    const q = await quoteFor(l, now);
    if (q.eligible) out[l.id] = q;
  }
  return out;
}

export interface CancelInput {
  loanId: string;
  /** explicit confirmation of the exit */
  confirmExit: boolean;
  /** the payable amount the borrower was shown; refused if it has since changed (interest accrues by the day) */
  expectedPayablePaise: number;
}

/** Borrower exit inside the cooling-off period. Idempotent for a loan that is already cancelled by exit. */
export async function cancelLoanInCoolingOff(actor: Actor, input: CancelInput, now = new Date()): Promise<{ loan: LoanView; payablePaise: number }> {
  const loan = await ownedLoan(actor, input.loanId);
  if (loan.status === "cancelled" && loan.cancelReason === "cooling_off") return { loan: toLoanView(loan), payablePaise: num(loan.exitAmountPaise) };
  if (input.confirmExit !== true) throw new DomainError("validation", "Please confirm that you want to exit this loan.");
  const q = await quoteFor(loan, now);
  if (!q.eligible) {
    throw new DomainError("conflict", q.blocked === "window_over" ? "The cooling-off period for this loan has ended." : q.blocked === "escrow_settling" ? "This loan is being repaid from the escrow release and cannot be cancelled now." : "This loan is already closed.");
  }
  if (input.expectedPayablePaise !== q.payablePaise) throw new DomainError("validation", "The exit amount has changed. Please review it and confirm again.", { payablePaise: q.payablePaise });
  const partner = getCreditPartner(loan.partner);
  let result;
  try {
    result = await partner.cancel(loan.partnerLoanRef, "cooling_off");
  } catch (err) {
    console.error("[credit] partner cancel failed", err);
    throw new DomainError("conflict", "Our lending partner could not cancel the loan right now. Nothing has changed. Please try again.");
  }
  if (result.status !== "cancelled") throw new DomainError("conflict", "Our lending partner could not cancel the loan. Nothing has changed.");
  const payable = result.exitAmountPaise ?? q.payablePaise;
  await prisma.$transaction((tx) => recordCancellation(tx, loan.id, { reason: "cooling_off", at: now, exitAmountPaise: payable }));
  // escrow's claim goes to zero (the worker retries via CreditCancelled if escrow is unreachable here)
  try { await syncEscrowAssignment(loan.id); } catch (err) { console.error("[credit] escrow assignment sync after cancel failed (worker will retry)", loan.id, err); }
  const fresh = await prisma.creditLoan.findUniqueOrThrow({ where: { id: loan.id } });
  return { loan: toLoanView(fresh), payablePaise: payable };
}
