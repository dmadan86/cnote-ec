export interface PlanView {
  code: string;
  name: string;
  monthlyPricePaise: number;
  monthlyCredits: number;
  features: string[];
}
export interface SubscriptionView {
  id: string;
  planCode: string;
  status: "active" | "cancelled" | "expired";
  periodStart: string;
  periodEnd: string;
  autoRenew: boolean;
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
/** Result of a self-serve cancel; `refundPaise` is recorded (payment is mocked in Phase 1). */
export interface CancellationQuote {
  subscriptionId: string;
  planCode: string;
  refundPaise: number;
}
/** Remaining spendable credits grouped by expiry (for "N credits expire on …" UI). */
export interface CreditLot {
  id: string;
  remaining: number;
  expiresAt: string;
}
