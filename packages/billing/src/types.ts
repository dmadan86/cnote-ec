export interface PlanView {
  code: string;
  name: string;
  monthlyPricePaise: number;
  monthlyCredits: number;
  /** Annual billing discount (bps off 12 x monthly) and the resulting ex-GST annual price. */
  annualDiscountBps: number;
  annualPricePaise: number;
  features: string[];
}
export interface SubscriptionView {
  id: string;
  planCode: string;
  status: "active" | "cancelled" | "expired";
  periodStart: string;
  periodEnd: string;
  autoRenew: boolean;
  billingInterval: "monthly" | "annual";
}
export interface LedgerEntryView {
  id: string;
  delta: number;
  reason: "grant" | "consume" | "refund" | "expire";
  refType: string | null;
  refId: string | null;
  expiresAt: string | null;
  createdAt: string;
}
/**
 * What cancelling does (preview) and what it did (result). `refundPaise` is the GST-inclusive amount returned through the
 * payment provider: the unused full months of an annual plan, 0 for monthly plans. The paid plan ends at `effectiveAt`
 * (now); the business moves to Free for the rest of the original period and keeps every credit lot until its own expiry.
 */
export interface CancellationQuote {
  subscriptionId: string;
  planCode: string;
  billingInterval: "monthly" | "annual";
  refundPaise: number;
  unusedMonths: number;
  effectiveAt: string;
  originalPeriodEnd: string;
  creditsKept: number;
  creditLots: CreditLot[];
}
/** Remaining spendable credits grouped by expiry (for "N credits expire on …" UI). */
export interface CreditLot {
  id: string;
  remaining: number;
  expiresAt: string;
}
