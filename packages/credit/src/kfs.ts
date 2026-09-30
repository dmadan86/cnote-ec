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
  return Math.round((cost / t.principalPaise) * (365 / t.tenorDays) * 10_000);
}

export function buildKfs(product: Product, t: OfferTerms, lender: LenderInfo, env: NodeJS.ProcessEnv = process.env): Kfs {
  const cfg = creditConfig(env);
  return {
    version: "kfs-v1", product, lenderName: lender.name, grievanceOfficer: lender.grievance,
    principalPaise: t.principalPaise, tenorDays: t.tenorDays, aprBps: t.aprBps, allInAprBps: allInAprBps(t),
    interestPaise: interestPaise(t.principalPaise, t.aprBps, t.tenorDays),
    processingFeePaise: t.processingFeePaise, otherFeesPaise: t.otherFeesPaise, totalRepayablePaise: totalRepayablePaise(t),
    lateFeeBpsPerMonth: cfg.lateFeeBpsPerMonth, coolingOffDays: cfg.coolingOffDays, prepaymentCharge: "none",
    repayment: product === "invoice_financing" ? "escrow_release" : "buyer_instalment",
  };
}
