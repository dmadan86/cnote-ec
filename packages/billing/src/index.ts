// @cnote/billing — plans, subscriptions, lead-credit ledger (ADR-005).
// PUBLIC CONTRACT — other modules depend on these signatures. Extend, don't break.
import type { ModuleWorker } from "@cnote/core";
import type { Tx } from "@cnote/db";

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

export async function listPlans(): Promise<PlanView[]> {
  throw new Error("not implemented");
}
/** Spendable credits (non-expired). */
export async function getBalance(businessId: string): Promise<number> {
  void businessId;
  throw new Error("not implemented");
}
export async function getLedger(businessId: string, limit = 50): Promise<LedgerEntryView[]> {
  void businessId; void limit;
  throw new Error("not implemented");
}
/**
 * Consume one lead credit inside the caller's transaction (only on lead ACCEPT, ADR-005).
 * Throws DomainError("insufficient_credits"). Returns the ledger entry id.
 */
export async function consumeCredit(tx: Tx, businessId: string, ref: { refType: string; refId: string }): Promise<string> {
  void tx; void businessId; void ref;
  throw new Error("not implemented");
}
/** Idempotent refund of a prior consume (ADR-002 auto-refund). */
export async function refundCredit(tx: Tx, consumeTxnId: string): Promise<string | null> {
  void tx; void consumeTxnId;
  throw new Error("not implemented");
}
export async function getActiveSubscription(businessId: string): Promise<SubscriptionView | null> {
  void businessId;
  throw new Error("not implemented");
}
/** Starts a plan (payment is mocked in Phase 1), grants monthly credits (+90-day expiry). autoRenew always false. */
export async function subscribe(businessId: string, planCode: string): Promise<SubscriptionView> {
  void businessId; void planCode;
  throw new Error("not implemented");
}
/** Self-serve cancel; annual plans get pro-rated refund (recorded, payment mocked). */
export async function cancelSubscription(businessId: string): Promise<void> {
  void businessId;
  throw new Error("not implemented");
}

/** Handlers: BusinessCreated → free plan + credits. Jobs: expire lapsed credits, end periods. */
export const worker: ModuleWorker = { name: "billing", handlers: {}, jobs: [] };
