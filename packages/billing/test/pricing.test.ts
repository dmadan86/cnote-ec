import { describe, expect, it } from "vitest";
import {
  addMonths, annualRefundPaise, calculatePricing, gstOnPaise, planPeriodPricePaise, recommendPlan, unusedFullMonths, usedMonths,
  type PricedPlan,
} from "../src/pricing";

const free: PricedPlan = { code: "free", name: "Free", monthlyPricePaise: 0, monthlyCredits: 10, annualDiscountBps: 2000 };
const starter: PricedPlan = { code: "starter", name: "Starter", monthlyPricePaise: 99_900, monthlyCredits: 60, annualDiscountBps: 2000 };
const pro: PricedPlan = { code: "pro", name: "Pro", monthlyPricePaise: 299_900, monthlyCredits: 250, annualDiscountBps: 2000 };

describe("planPeriodPricePaise", () => {
  it("monthly is the list price; annual is 12 months less the configured discount, floored", () => {
    expect(planPeriodPricePaise(starter, "monthly")).toBe(99_900);
    expect(planPeriodPricePaise(starter, "annual")).toBe(959_040); // 1,198,800 x 0.8
    expect(planPeriodPricePaise({ monthlyPricePaise: 99_900, annualDiscountBps: 0 }, "annual")).toBe(1_198_800);
    expect(planPeriodPricePaise({ monthlyPricePaise: 333, annualDiscountBps: 1234 }, "annual")).toBe(Math.floor((333 * 12 * (10_000 - 1234)) / 10_000));
    expect(planPeriodPricePaise({ monthlyPricePaise: 0, annualDiscountBps: 2000 }, "annual")).toBe(0);
  });
  it("rejects non-integer money and out-of-range discounts", () => {
    expect(() => planPeriodPricePaise({ monthlyPricePaise: 1.5, annualDiscountBps: 0 }, "monthly")).toThrow(RangeError);
    expect(() => planPeriodPricePaise({ monthlyPricePaise: -1, annualDiscountBps: 0 }, "annual")).toThrow(RangeError);
    expect(() => planPeriodPricePaise({ monthlyPricePaise: 100, annualDiscountBps: 10_001 }, "annual")).toThrow(RangeError);
  });
});

describe("gstOnPaise", () => {
  it("rounds half-up to the paisa", () => {
    expect(gstOnPaise(99_900, 1800)).toBe(17_982);
    expect(gstOnPaise(959_040, 1800)).toBe(172_627); // 172,627.2
    expect(gstOnPaise(25, 1800)).toBe(5); // 4.5 rounds up
    expect(gstOnPaise(0, 1800)).toBe(0);
  });
  it("rejects bad input", () => {
    expect(() => gstOnPaise(-1, 1800)).toThrow(RangeError);
    expect(() => gstOnPaise(100, 1.5)).toThrow(RangeError);
  });
});

describe("calculatePricing", () => {
  it("monthly Starter, 40 leads: price, GST, per-lead cost, spare credits roll over for 90 days", () => {
    const r = calculatePricing({ plan: starter, interval: "monthly", leadsPerMonth: 40 });
    expect(r).toMatchObject({
      exGstPaise: 99_900, gstPaise: 17_982, totalPaise: 117_882, monthlyEquivalentPaise: 117_882, annualSavingPaise: 0,
      coveredLeadsPerMonth: 40, spareCreditsPerMonth: 20, shortfallLeadsPerMonth: 0, costPerLeadPaise: 2947, creditExpiryDays: 90, periodMonths: 1,
    });
  });
  it("annual Starter: one payment for 12 months, effective monthly price and saving shown", () => {
    const r = calculatePricing({ plan: starter, interval: "annual", leadsPerMonth: 60 });
    expect(r).toMatchObject({ exGstPaise: 959_040, gstPaise: 172_627, totalPaise: 1_131_667, periodMonths: 12, monthlyEquivalentPaise: 94_305, annualSavingPaise: 239_760, costPerLeadPaise: 1572 });
  });
  it("more leads than credits: cost per lead uses the covered leads and the shortfall is reported", () => {
    const r = calculatePricing({ plan: starter, interval: "monthly", leadsPerMonth: 100 });
    expect(r).toMatchObject({ coveredLeadsPerMonth: 60, shortfallLeadsPerMonth: 40, spareCreditsPerMonth: 0 });
  });
  it("free plan or zero leads has no per-lead cost", () => {
    expect(calculatePricing({ plan: free, interval: "monthly", leadsPerMonth: 5 }).costPerLeadPaise).toBeNull();
    expect(calculatePricing({ plan: pro, interval: "monthly", leadsPerMonth: 0 }).costPerLeadPaise).toBeNull();
  });
  it("honours a different GST rate and clamps absurd lead counts", () => {
    expect(calculatePricing({ plan: starter, interval: "monthly", leadsPerMonth: 10, gstRateBps: 500 }).gstPaise).toBe(4995);
    expect(calculatePricing({ plan: starter, interval: "monthly", leadsPerMonth: 10_000_000 }).leadsPerMonth).toBe(2000);
    expect(() => calculatePricing({ plan: starter, interval: "monthly", leadsPerMonth: -1 })).toThrow(RangeError);
    expect(() => calculatePricing({ plan: starter, interval: "monthly", leadsPerMonth: 1.5 })).toThrow(RangeError);
  });
});

describe("recommendPlan", () => {
  it("cheapest plan that covers the leads, else the biggest", () => {
    const plans = [pro, free, starter];
    expect(recommendPlan(plans, 5)!.code).toBe("free");
    expect(recommendPlan(plans, 40)!.code).toBe("starter");
    expect(recommendPlan(plans, 200)!.code).toBe("pro");
    expect(recommendPlan(plans, 900)!.code).toBe("pro");
    expect(recommendPlan([], 1)).toBeNull();
  });
});

describe("calendar months and annual refunds", () => {
  const t0 = new Date("2026-01-31T10:00:00Z");
  it("addMonths clamps the day to the end of a shorter month", () => {
    expect(addMonths(t0, 1).toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(addMonths(t0, 12).toISOString()).toBe("2027-01-31T10:00:00.000Z");
    expect(addMonths(new Date("2024-01-31T00:00:00Z"), 1).toISOString()).toBe("2024-02-29T00:00:00.000Z");
  });
  const start = new Date("2026-03-10T08:00:00Z");
  it("the first month always counts as used (credits are granted up front); a started month is not refunded", () => {
    expect(usedMonths(start, start)).toBe(1);
    expect(usedMonths(start, new Date("2026-03-10T08:00:01Z"))).toBe(1);
    expect(usedMonths(start, new Date("2026-04-10T08:00:00Z"))).toBe(1); // second month starts at this instant
    expect(usedMonths(start, new Date("2026-04-10T08:00:01Z"))).toBe(2);
    expect(usedMonths(start, new Date("2026-09-01T00:00:00Z"))).toBe(6);
    expect(usedMonths(start, new Date("2028-01-01T00:00:00Z"))).toBe(12);
    expect(unusedFullMonths(start, new Date("2026-03-20T00:00:00Z"))).toBe(11);
    expect(unusedFullMonths(start, new Date("2026-08-20T00:00:00Z"))).toBe(6);
  });
  it("refund = floor(paid x unused / 12)", () => {
    expect(annualRefundPaise(1_131_667, 11)).toBe(1_037_361); // 1,131,667 x 11 / 12 = 1,037,361.4
    expect(annualRefundPaise(1_131_667, 0)).toBe(0);
    expect(annualRefundPaise(1_131_667, 12)).toBe(1_131_667);
    expect(() => annualRefundPaise(100, 13)).toThrow(RangeError);
    expect(() => annualRefundPaise(100, 1.5)).toThrow(RangeError);
    expect(() => annualRefundPaise(-1, 1)).toThrow(RangeError);
  });
});
