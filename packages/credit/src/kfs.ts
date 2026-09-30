// Offer arithmetic + Key Fact Statement (RBI digital lending guidelines). Pure, integer paise.
import { creditConfig } from "./config";
import type { Kfs, LenderInfo, Product } from "./types";

export interface OfferTerms { principalPaise: number; aprBps: number; tenorDays: number; processingFeePaise: number; otherFeesPaise: number }

/** Simple interest on the principal for the tenor (act/365), rounded to paise. */
export const interestPaise = (principalPaise: number, aprBps: number, tenorDays: number): number =>
  Math.round((principalPaise * aprBps * tenorDays) / (10_000 * 365));

export const totalRepayablePaise = (t: OfferTerms): number => t.principalPaise + interestPaise(t.principalPaise, t.aprBps, t.tenorDays) + t.processingFeePaise + t.otherFeesPaise;

/** All-in annualised cost (interest + fees) as bps of principal. */
export function allInAprBps(t: OfferTerms): number {
  if (t.principalPaise <= 0 || t.tenorDays <= 0) return 0;
  const cost = interestPaise(t.principalPaise, t.aprBps, t.tenorDays) + t.processingFeePaise + t.otherFeesPaise;
  // Paise rounding of the interest can pull the recomputed rate a basis point under the contract rate on small, short
  // loans; the disclosed all-in APR (contract rate + fees, RBI KFS) must never understate the contract rate.
  return Math.max(t.aprBps, Math.round((cost / t.principalPaise) * (365 / t.tenorDays) * 10_000));
}

export function buildKfs(product: Product, t: OfferTerms, lender: LenderInfo, env: NodeJS.ProcessEnv = process.env): Kfs {
  const cfg = creditConfig(env);
  return {
    version: "kfs-v1", product, lenderName: lender.name, grievanceOfficer: lender.grievance,
    principalPaise: t.principalPaise, tenorDays: t.tenorDays, aprBps: t.aprBps, allInAprBps: allInAprBps(t),
    interestPaise: interestPaise(t.principalPaise, t.aprBps, t.tenorDays),
    processingFeePaise: t.processingFeePaise, otherFeesPaise: t.otherFeesPaise, totalRepayablePaise: totalRepayablePaise(t),
    lateFeeBpsPerMonth: cfg.lateFeeBpsPerMonth, coolingOffDays: cfg.coolingOffDays, prepaymentCharge: "none",
    coolingOffExit: "principal_plus_pro_rata_interest", coolingOffFeesWaived: cfg.coolingOffWaivesFees,
    repayment: product === "invoice_financing" ? "escrow_release" : "buyer_instalment",
  };
}

// ---- Cooling-off exit (RBI digital lending guidelines) ---------------------------------------------------------------------

export interface CoolingOffTerms { principalPaise: number; aprBps: number; tenorDays: number; feesPaise: number; repaidPaise: number; disbursedAt: Date }
export interface CoolingOffAmount {
  /** whole days of interest charged: elapsed days rounded up, at least 1, at most the tenor */
  interestDays: number;
  principalPaise: number;
  /** interest accrued pro rata (same act/365 simple interest as the offer) */
  interestPaise: number;
  /** fees kept by the lender (0 when the config waives them) */
  feesPaise: number;
  /** principal + interest + fees */
  exitTotalPaise: number;
  repaidPaise: number;
  /** what the borrower still has to pay the lender to exit: exit total less anything already repaid */
  payablePaise: number;
}

/** Exact exit amount at `now`: principal + interest accrued pro rata + fees kept (no penalty, no prepayment charge). Pure, integer paise. */
export function coolingOffAmount(t: CoolingOffTerms, now: Date, waivesFees = false): CoolingOffAmount {
  const elapsedDays = Math.max(0, (now.getTime() - t.disbursedAt.getTime()) / 86_400_000);
  const interestDays = Math.min(t.tenorDays, Math.max(1, Math.ceil(elapsedDays)));
  const interest = interestPaise(t.principalPaise, t.aprBps, interestDays);
  const fees = waivesFees ? 0 : t.feesPaise;
  const exitTotalPaise = t.principalPaise + interest + fees;
  return { interestDays, principalPaise: t.principalPaise, interestPaise: interest, feesPaise: fees, exitTotalPaise, repaidPaise: t.repaidPaise, payablePaise: Math.max(0, exitTotalPaise - t.repaidPaise) };
}
