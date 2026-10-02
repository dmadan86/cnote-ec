// Pure pricing maths shared by the public /pricing calculator, the seller app and checkout (ADR-005).
// No I/O and no server-only imports, so client components can import it via "@cnote/billing/pricing".
// Money is integer paise. GST uses the same half-up rounding as invoices.splitGst (see test/pricing.property.test.ts).
import { CREDIT_TTL_DAYS } from "./credits";

export type BillingInterval = "monthly" | "annual";
export const BILLING_INTERVALS: readonly BillingInterval[] = ["monthly", "annual"];
export const ANNUAL_MONTHS = 12;
export const DEFAULT_GST_RATE_BPS = 1800;
export const DEFAULT_ANNUAL_DISCOUNT_BPS = 2000;
export const MAX_CALCULATOR_LEADS = 2000;

/** The slice of a plan the maths needs (a PlanView satisfies it). */
export interface PricedPlan { code: string; name: string; monthlyPricePaise: number; monthlyCredits: number; annualDiscountBps?: number }

const assertPaise = (n: number, what: string) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${what} must be a non-negative integer (paise)`);
};
const assertBps = (n: number, what: string) => {
  if (!Number.isInteger(n) || n < 0 || n > 10_000) throw new RangeError(`${what} must be an integer in 0..10000 (bps)`);
};

/** GST on a taxable value, half-up to the paisa (identical to invoices.splitGst). */
export function gstOnPaise(taxablePaise: number, rateBps: number): number {
  assertPaise(taxablePaise, "Taxable value");
  if (!Number.isInteger(rateBps) || rateBps < 0) throw new RangeError("GST rate must be a non-negative integer (bps)");
  return Math.floor((taxablePaise * rateBps + 5000) / 10_000);
}

/** Ex-GST price of a plan for one billing period. Annual = 12 x monthly less the plan's discount, floored to the paisa. */
export function planPeriodPricePaise(plan: Pick<PricedPlan, "monthlyPricePaise" | "annualDiscountBps">, interval: BillingInterval): number {
  assertPaise(plan.monthlyPricePaise, "Monthly price");
  if (interval === "monthly") return plan.monthlyPricePaise;
  const bps = plan.annualDiscountBps ?? DEFAULT_ANNUAL_DISCOUNT_BPS;
  assertBps(bps, "Annual discount");
  return Math.floor((plan.monthlyPricePaise * ANNUAL_MONTHS * (10_000 - bps)) / 10_000);
}

export interface PricingInput {
  plan: PricedPlan;
  interval: BillingInterval;
  /** Leads the seller expects to accept in a month (each accepted lead costs one credit). */
  leadsPerMonth: number;
  gstRateBps?: number;
}
export interface PricingResult {
  planCode: string;
  planName: string;
  interval: BillingInterval;
  periodMonths: number;
  leadsPerMonth: number;
  /** Ex-GST price for the whole period, GST on it, and the total charged. */
  exGstPaise: number;
  gstPaise: number;
  totalPaise: number;
  gstRateBps: number;
  /** Total charged per month of the period (rounded down). */
  monthlyEquivalentPaise: number;
  /** What annual billing saves against 12 monthly payments, ex-GST (0 for monthly). */
  annualSavingPaise: number;
  creditsPerMonth: number;
  /** Leads the plan covers each month, spare credits that roll over, and leads needing a top-up pack. */
  coveredLeadsPerMonth: number;
  spareCreditsPerMonth: number;
  shortfallLeadsPerMonth: number;
  /** GST-inclusive cost of one covered lead (monthly equivalent / covered leads); null when nothing is covered or the plan is free. */
  costPerLeadPaise: number | null;
  /** Every grant (one per month, also on annual plans) stays spendable this many days. */
  creditExpiryDays: number;
}

export function calculatePricing(input: PricingInput): PricingResult {
  const { plan, interval } = input;
  const gstRateBps = input.gstRateBps ?? DEFAULT_GST_RATE_BPS;
  if (!Number.isInteger(input.leadsPerMonth) || input.leadsPerMonth < 0) throw new RangeError("Leads per month must be a non-negative integer");
  const leads = Math.min(input.leadsPerMonth, MAX_CALCULATOR_LEADS);
  const periodMonths = interval === "annual" ? ANNUAL_MONTHS : 1;
  const exGstPaise = planPeriodPricePaise(plan, interval);
  const gstPaise = gstOnPaise(exGstPaise, gstRateBps);
  const totalPaise = exGstPaise + gstPaise;
  const monthlyEquivalentPaise = Math.floor(totalPaise / periodMonths);
  const covered = Math.min(leads, plan.monthlyCredits);
  return {
    planCode: plan.code, planName: plan.name, interval, periodMonths, leadsPerMonth: leads,
    exGstPaise, gstPaise, totalPaise, gstRateBps, monthlyEquivalentPaise,
    annualSavingPaise: interval === "annual" ? plan.monthlyPricePaise * ANNUAL_MONTHS - exGstPaise : 0,
    creditsPerMonth: plan.monthlyCredits,
    coveredLeadsPerMonth: covered,
    spareCreditsPerMonth: Math.max(0, plan.monthlyCredits - leads),
    shortfallLeadsPerMonth: Math.max(0, leads - plan.monthlyCredits),
    costPerLeadPaise: covered > 0 && totalPaise > 0 ? Math.round(monthlyEquivalentPaise / covered) : null,
    creditExpiryDays: CREDIT_TTL_DAYS,
  };
}

/** Cheapest plan whose monthly credits cover the leads; else the largest plan (with a shortfall). */
export function recommendPlan<P extends PricedPlan>(plans: readonly P[], leadsPerMonth: number): P | null {
  if (plans.length === 0) return null;
  const sorted = [...plans].sort((a, b) => a.monthlyPricePaise - b.monthlyPricePaise || a.monthlyCredits - b.monthlyCredits);
  return sorted.find((p) => p.monthlyCredits >= leadsPerMonth) ?? sorted[sorted.length - 1]!;
}

// ---- annual periods and pro-rated refunds ------------------------------------------------------------------------

/** `d` plus `n` calendar months in UTC, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + n);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}

/**
 * Months of an annual period that count as used at `now`. A month that has started is used (a partly used month is not
 * refunded) and the first month is always used, because its credits are granted up front (no buy-claim-refund loop).
 */
export function usedMonths(periodStart: Date, now: Date): number {
  let k = 0;
  while (k < ANNUAL_MONTHS && addMonths(periodStart, k) < now) k++;
  return Math.min(ANNUAL_MONTHS, Math.max(1, k));
}
export const unusedFullMonths = (periodStart: Date, now: Date): number => ANNUAL_MONTHS - usedMonths(periodStart, now);

/** Refund of the unused full months: floor(paid x unused / 12). `paidPaise` is what the customer actually paid, GST included. */
export function annualRefundPaise(paidPaise: number, unusedMonths: number): number {
  assertPaise(paidPaise, "Paid amount");
  if (!Number.isInteger(unusedMonths) || unusedMonths < 0 || unusedMonths > ANNUAL_MONTHS) throw new RangeError("Unused months must be 0..12");
  return Math.floor((paidPaise * unusedMonths) / ANNUAL_MONTHS);
}

export const CANCEL_REASONS = ["too_expensive", "not_enough_leads", "switching_tool", "business_closed", "other"] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];
