import { DomainError, emit } from "@cnote/core";
import { prisma, type Tx } from "@cnote/db";
import { addDays } from "./credits";
import { getCreditLots, grantCreditsTx, lockBusiness } from "./ledger";
import { getPlan } from "./plans";
import { addMonths, ANNUAL_MONTHS, annualRefundPaise, CANCEL_REASONS, unusedFullMonths, type BillingInterval } from "./pricing";
import type { CancellationQuote, SubscriptionView } from "./types";

const PERIOD_DAYS = 30;
/** Remind this long before a paid period ends (annual plans need longer notice). */
const REMINDER_LEAD_DAYS: Record<BillingInterval, number> = { monthly: 3, annual: 14 };

type SubRow = { id: string; planCode: string; status: SubscriptionView["status"]; periodStart: Date; periodEnd: Date; autoRenew: boolean; billingInterval: string };
type PaidSubRow = SubRow & { paymentOrderId: string | null };
const intervalOf = (v: string): BillingInterval => (v === "annual" ? "annual" : "monthly");

function toView(s: SubRow): SubscriptionView {
  return {
    id: s.id,
    planCode: s.planCode,
    status: s.status,
    periodStart: s.periodStart.toISOString(),
    periodEnd: s.periodEnd.toISOString(),
    autoRenew: s.autoRenew,
    billingInterval: intervalOf(s.billingInterval),
  };
}

export async function getActiveSubscription(businessId: string): Promise<SubscriptionView | null> {
  const s = await prisma.subscription.findFirst({
    where: { businessId, status: "active", periodEnd: { gt: new Date() } },
    orderBy: { periodStart: "desc" },
  });
  return s ? toView(s) : null;
}

interface StartOpts { periodEnd?: Date; grant: boolean; interval?: BillingInterval; paymentOrderId?: string }

/**
 * Opens a subscription period and grants that period's credits. autoRenew is never true (ADR-005).
 * Annual periods last 12 calendar months and receive their credits one month at a time (grantDueAnnualCredits), so
 * every grant keeps its own 90-day rollover instead of 12 months of credits lapsing together.
 */
async function startPeriod(tx: Tx, businessId: string, planCode: string, opts: StartOpts) {
  const plan = await getPlan(planCode);
  const now = new Date();
  const annual = opts.interval === "annual";
  const sub = await tx.subscription.create({
    data: {
      businessId, planCode, status: "active", periodStart: now, autoRenew: false,
      periodEnd: opts.periodEnd ?? (annual ? addMonths(now, ANNUAL_MONTHS) : addDays(now, PERIOD_DAYS)),
      billingInterval: annual ? "annual" : "monthly",
      paymentOrderId: opts.paymentOrderId ?? null,
      nextGrantAt: annual ? addMonths(now, 1) : null,
    },
  });
  if (opts.grant && plan.monthlyCredits > 0) {
    await grantCreditsTx(tx, businessId, plan.monthlyCredits, `plan:${planCode}`, { refType: "subscription", refId: sub.id });
  }
  await emit(tx, "SubscriptionStarted", { type: "business", id: businessId }, { businessId, subscriptionId: sub.id, planCode });
  return sub;
}

/** Switches the business to `planCode` inside the caller's tx (payment already captured, or free). Used by checkout fulfilment. */
export async function activatePlanTx(tx: Tx, businessId: string, planCode: string, opts: { allowSame?: boolean; interval?: BillingInterval; paymentOrderId?: string } = {}) {
  await lockBusiness(tx, businessId);
  const current = await tx.subscription.findFirst({ where: { businessId, status: "active", periodEnd: { gt: new Date() } } });
  if (current && current.planCode === planCode && !opts.allowSame) throw new DomainError("conflict", "You are already on this plan.");
  // Replacing a plan is a change, not churn: no SubscriptionCancelled event.
  if (current) await tx.subscription.update({ where: { id: current.id }, data: { status: "cancelled", cancelledAt: new Date() } });
  return startPeriod(tx, businessId, planCode, { grant: true, interval: opts.interval, paymentOrderId: opts.paymentOrderId });
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

// ---- cancellation (ADR-005: self-serve, pro-rated refund of unused full months on annual plans) ---------------------

type Reader = Pick<Tx, "paymentOrder" | "paymentRefund">;

/** GST-inclusive refund for cancelling `sub` at `now`: unused full months of what was actually paid, never more than is left. */
async function refundFor(db: Reader, sub: PaidSubRow, now: Date): Promise<{ refundPaise: number; unusedMonths: number }> {
  if (intervalOf(sub.billingInterval) !== "annual") return { refundPaise: 0, unusedMonths: 0 };
  const unusedMonths = unusedFullMonths(sub.periodStart, now);
  if (!sub.paymentOrderId) return { refundPaise: 0, unusedMonths }; // dev/manual subscription: nothing was paid through us
  const order = await db.paymentOrder.findUnique({ where: { id: sub.paymentOrderId } });
  if (!order?.fulfilledAt || (order.status !== "paid" && order.status !== "partially_refunded")) return { refundPaise: 0, unusedMonths };
  const refunded = (await db.paymentRefund.findMany({ where: { paymentOrderId: order.id, status: { not: "failed" } } })).reduce((a, r) => a + Number(r.amountPaise), 0);
  const refundPaise = Math.min(annualRefundPaise(Number(order.totalPaise), unusedMonths), Number(order.totalPaise) - refunded);
  return { refundPaise: Math.max(0, refundPaise), unusedMonths };
}

async function buildQuote(db: Reader, sub: PaidSubRow, businessId: string, now: Date): Promise<CancellationQuote> {
  const { refundPaise, unusedMonths } = await refundFor(db, sub, now);
  const creditLots = await getCreditLots(businessId);
  return {
    subscriptionId: sub.id, planCode: sub.planCode, billingInterval: intervalOf(sub.billingInterval), refundPaise, unusedMonths,
    effectiveAt: now.toISOString(), originalPeriodEnd: sub.periodEnd.toISOString(),
    creditsKept: creditLots.reduce((a, l) => a + l.remaining, 0), creditLots,
  };
}

/** Read-only: exactly what cancelling right now would do (the confirm screen shows this). */
export async function previewCancellation(businessId: string): Promise<CancellationQuote> {
  const now = new Date();
  const current = await prisma.subscription.findFirst({ where: { businessId, status: "active", periodEnd: { gt: now } }, orderBy: { periodStart: "desc" } });
  if (!current || current.planCode === "free") throw new DomainError("not_found", "You have no paid plan to cancel.");
  return buildQuote(prisma, current, businessId, now);
}

/**
 * Self-serve cancel. Credits already granted stay spendable until their own expiry. The business
 * falls back to the free plan for the rest of the period WITHOUT a fresh grant (no farming free
 * credits by subscribing/cancelling); the monthly job re-grants at period end.
 * Idempotent: the business lock serialises concurrent calls and the second finds no paid plan (not_found), so the
 * event and the refund happen once.
 */
export async function cancelSubscriptionWithQuote(businessId: string, opts: { reason?: string } = {}): Promise<CancellationQuote> {
  const reason = opts.reason && (CANCEL_REASONS as readonly string[]).includes(opts.reason) ? opts.reason : null;
  const done = await prisma.$transaction(async (tx) => {
    await lockBusiness(tx, businessId);
    const now = new Date();
    const current = await tx.subscription.findFirst({ where: { businessId, status: "active", periodEnd: { gt: now } }, orderBy: { periodStart: "desc" } });
    if (!current || current.planCode === "free") throw new DomainError("not_found", "You have no paid plan to cancel.");
    const quote = await buildQuote(tx, current, businessId, now);
    await tx.subscription.update({ where: { id: current.id }, data: { status: "cancelled", cancelledAt: now } });
    await emit(tx, "SubscriptionCancelled", { type: "business", id: businessId }, {
      businessId, subscriptionId: current.id, planCode: current.planCode, billingInterval: quote.billingInterval, refundPaise: quote.refundPaise,
      unusedMonths: quote.unusedMonths, effectiveAt: quote.effectiveAt, reason,
    });
    // Free for the rest of the paid period (an annual one is capped at a month; the lapse job then re-grants Free's monthly credits).
    const freeEnd = addDays(now, PERIOD_DAYS);
    await startPeriod(tx, businessId, "free", { grant: false, periodEnd: current.periodEnd < freeEnd ? current.periodEnd : freeEnd });
    return { quote, paymentOrderId: current.paymentOrderId };
  });
  // Money back through the payment provider after the cancel committed; a provider failure is logged for finance and
  // leaves a failed PaymentRefund row (the cancellation itself stands).
  const { quote, paymentOrderId } = done;
  if (quote.refundPaise > 0 && paymentOrderId) {
    const { refundPayment } = await import("./payments");
    await refundPayment(paymentOrderId, quote.refundPaise, `Pro-rata refund on cancelling ${quote.planCode} (${quote.unusedMonths} unused months)`)
      .catch((e) => console.error(`[billing] pro-rata refund failed business=${businessId}`, e));
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

/**
 * Job: annual plans get their credits one month at a time. Idempotent per (subscription, due date) through the grant's
 * refId and a compare-and-set on nextGrantAt, so redelivery or two workers never double-grant.
 */
export async function grantDueAnnualCredits(now = new Date()): Promise<number> {
  const due = await prisma.subscription.findMany({ where: { status: "active", billingInterval: "annual", nextGrantAt: { lte: now } }, take: 500 });
  let n = 0;
  for (const s of due) {
    const granted = await prisma.$transaction(async (tx) => {
      await lockBusiness(tx, s.businessId);
      const at = s.nextGrantAt!;
      const next = addMonths(s.periodStart, Math.round((at.getUTCFullYear() - s.periodStart.getUTCFullYear()) * 12 + at.getUTCMonth() - s.periodStart.getUTCMonth()) + 1);
      const { count } = await tx.subscription.updateMany({
        where: { id: s.id, status: "active", nextGrantAt: at },
        data: { nextGrantAt: next < s.periodEnd ? next : null },
      });
      if (count === 0) return false;
      const plan = await getPlan(s.planCode);
      if (plan.monthlyCredits > 0) await grantCreditsTx(tx, s.businessId, plan.monthlyCredits, `plan:${s.planCode}:annual`, { refType: "subscription", refId: `${s.id}:${at.toISOString()}` });
      return true;
    });
    if (granted) n++;
  }
  return n;
}

/**
 * Job: paid plans never renew on their own, so shortly before the period ends we emit SubscriptionRenewalDue, which the
 * notifications module turns into a message asking the owner to confirm a renewal. Once per period.
 */
export async function sendRenewalReminders(now = new Date()): Promise<number> {
  const horizon = addDays(now, Math.max(...Object.values(REMINDER_LEAD_DAYS)));
  const cands = await prisma.subscription.findMany({
    where: { status: "active", planCode: { not: "free" }, renewalRemindedAt: null, periodEnd: { gt: now, lte: horizon } },
    take: 500,
  });
  let n = 0;
  for (const s of cands) {
    if (s.periodEnd > addDays(now, REMINDER_LEAD_DAYS[intervalOf(s.billingInterval)])) continue;
    const sent = await prisma.$transaction(async (tx) => {
      const { count } = await tx.subscription.updateMany({ where: { id: s.id, status: "active", renewalRemindedAt: null }, data: { renewalRemindedAt: now } });
      if (count === 0) return false;
      await emit(tx, "SubscriptionRenewalDue", { type: "business", id: s.businessId }, {
        businessId: s.businessId, subscriptionId: s.id, planCode: s.planCode, billingInterval: intervalOf(s.billingInterval), periodEnd: s.periodEnd.toISOString(),
      });
      return true;
    });
    if (sent) n++;
  }
  return n;
}
