import { DomainError, emit } from "@cnote/core";
import { prisma, type Tx } from "@cnote/db";
import { addDays } from "./credits";
import { grantCreditsTx, lockBusiness } from "./ledger";
import { getPlan } from "./plans";
import type { CancellationQuote, SubscriptionView } from "./types";

const PERIOD_DAYS = 30;

function toView(s: { id: string; planCode: string; status: SubscriptionView["status"]; periodStart: Date; periodEnd: Date; autoRenew: boolean }): SubscriptionView {
  return {
    id: s.id,
    planCode: s.planCode,
    status: s.status,
    periodStart: s.periodStart.toISOString(),
    periodEnd: s.periodEnd.toISOString(),
    autoRenew: s.autoRenew,
  };
}

export async function getActiveSubscription(businessId: string): Promise<SubscriptionView | null> {
  const s = await prisma.subscription.findFirst({
    where: { businessId, status: "active", periodEnd: { gt: new Date() } },
    orderBy: { periodStart: "desc" },
  });
  return s ? toView(s) : null;
}

/** Opens a subscription period and grants that period's credits. autoRenew is never true (ADR-005). */
async function startPeriod(tx: Tx, businessId: string, planCode: string, opts: { periodEnd?: Date; grant: boolean }) {
  const plan = await getPlan(planCode);
  const now = new Date();
  const sub = await tx.subscription.create({
    data: { businessId, planCode, status: "active", periodStart: now, periodEnd: opts.periodEnd ?? addDays(now, PERIOD_DAYS), autoRenew: false },
  });
  if (opts.grant && plan.monthlyCredits > 0) {
    await grantCreditsTx(tx, businessId, plan.monthlyCredits, `plan:${planCode}`, { refType: "subscription", refId: sub.id });
  }
  await emit(tx, "SubscriptionStarted", { type: "business", id: businessId }, { businessId, subscriptionId: sub.id, planCode });
  return sub;
}

/** Switches the business to `planCode` inside the caller's tx (payment already captured, or free). Used by checkout fulfilment. */
export async function activatePlanTx(tx: Tx, businessId: string, planCode: string, opts: { allowSame?: boolean } = {}) {
  await lockBusiness(tx, businessId);
  const current = await tx.subscription.findFirst({ where: { businessId, status: "active", periodEnd: { gt: new Date() } } });
  if (current && current.planCode === planCode && !opts.allowSame) throw new DomainError("conflict", "You are already on this plan.");
  // Replacing a plan is a change, not churn: no SubscriptionCancelled event.
  if (current) await tx.subscription.update({ where: { id: current.id }, data: { status: "cancelled", cancelledAt: new Date() } });
  return startPeriod(tx, businessId, planCode, { grant: true });
}

/**
 * Starts a plan without a payment step: the free plan, or (dev only, PAYMENTS_PROVIDER=mock) a paid plan.
 * With a real gateway configured, paid plans must go through startCheckout (fulfilment calls activatePlanTx).
 */
export async function subscribe(businessId: string, planCode: string): Promise<SubscriptionView> {
  const plan = await getPlan(planCode);
  const provider = process.env.PAYMENTS_PROVIDER || "mock";
  if (plan.monthlyPricePaise > 0 && (provider !== "mock" || process.env.NODE_ENV === "production")) {
    throw new DomainError("validation", "Paid plans start from checkout.");
  }
  const sub = await prisma.$transaction((tx) => activatePlanTx(tx, businessId, planCode));
  return toView(sub);
}

/** Pro-rata share of the unused period; only for periods longer than a month (annual plans, ADR-005). */
export function proRataRefundPaise(pricePaise: number, periodStart: Date, periodEnd: Date, now: Date): number {
  const total = periodEnd.getTime() - periodStart.getTime();
  if (total <= 35 * 86_400_000) return 0;
  const left = Math.max(0, Math.min(total, periodEnd.getTime() - now.getTime()));
  return Math.floor((pricePaise * left) / total);
}

/**
 * Self-serve cancel. Credits already granted stay spendable until their own expiry. The business
 * falls back to the free plan for the rest of the period WITHOUT a fresh grant (no farming free
 * credits by subscribing/cancelling); the monthly job re-grants at period end.
 */
export async function cancelSubscriptionWithQuote(businessId: string): Promise<CancellationQuote> {
  const quote = await prisma.$transaction(async (tx) => {
    await lockBusiness(tx, businessId);
    const now = new Date();
    const current = await tx.subscription.findFirst({ where: { businessId, status: "active", periodEnd: { gt: now } }, orderBy: { periodStart: "desc" } });
    if (!current || current.planCode === "free") throw new DomainError("not_found", "You have no paid plan to cancel.");
    const plan = await getPlan(current.planCode);
    const refundPaise = proRataRefundPaise(plan.monthlyPricePaise, current.periodStart, current.periodEnd, now);
    await tx.subscription.update({ where: { id: current.id }, data: { status: "cancelled", cancelledAt: now } });
    await emit(tx, "SubscriptionCancelled", { type: "business", id: businessId }, { businessId, subscriptionId: current.id, planCode: current.planCode });
    await startPeriod(tx, businessId, "free", { grant: false, periodEnd: current.periodEnd });
    return { subscriptionId: current.id, planCode: current.planCode, refundPaise };
  });
  // Annual plans: pro-rata money back through the payment provider (after the cancel committed; failures are logged for finance).
  if (quote.refundPaise > 0) {
    const { refundForCancellation } = await import("./payments");
    await refundForCancellation(businessId, quote).catch((e) => console.error(`[billing] pro-rata refund failed business=${businessId}`, e));
  }
  return quote;
}

export async function cancelSubscription(businessId: string): Promise<void> {
  await cancelSubscriptionWithQuote(businessId);
}

/** BusinessCreated → free plan + its monthly credits. Idempotent (redelivery-safe). */
export async function startFreePlan(businessId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockBusiness(tx, businessId);
    const any = await tx.subscription.findFirst({ where: { businessId } });
    if (any) return;
    await startPeriod(tx, businessId, "free", { grant: true });
  });
}

/**
 * Job: subscriptions past periodEnd → expired. The business drops to (or stays on) the free plan,
 * which is re-granted every month. Paid plans never renew on their own (ADR-005).
 */
export async function endLapsedSubscriptions(now = new Date()): Promise<number> {
  const due = await prisma.subscription.findMany({ where: { status: "active", periodEnd: { lte: now } }, take: 500 });
  let n = 0;
  for (const s of due) {
    const changed = await prisma.$transaction(async (tx) => {
      await lockBusiness(tx, s.businessId);
      const { count } = await tx.subscription.updateMany({ where: { id: s.id, status: "active" }, data: { status: "expired" } });
      if (count === 0) return false;
      const stillActive = await tx.subscription.findFirst({ where: { businessId: s.businessId, status: "active", periodEnd: { gt: now } } });
      if (!stillActive) await startPeriod(tx, s.businessId, "free", { grant: true });
      return true;
    });
    if (changed) n++;
  }
  return n;
}
