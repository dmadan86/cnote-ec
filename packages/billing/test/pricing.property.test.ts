import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { splitGst } from "../src/invoices";
import { addMonths, annualRefundPaise, calculatePricing, gstOnPaise, planPeriodPricePaise, unusedFullMonths, usedMonths } from "../src/pricing";

const money = fc.integer({ min: 0, max: 50_000_000 });
const bps = fc.integer({ min: 0, max: 5000 });

describe("pricing properties (paise maths)", () => {
  it("GST matches the invoicing helper exactly, for any amount and rate, intra- or inter-state", () => {
    fc.assert(
      fc.property(money, fc.integer({ min: 0, max: 4000 }), fc.boolean(), (taxable, rate, intra) => {
        expect(gstOnPaise(taxable, rate)).toBe(splitGst(taxable, rate, intra).gstPaise);
      }),
    );
  });

  it("total = ex-GST + GST, all integers, and the invoice for the same amount agrees to the paisa", () => {
    fc.assert(
      fc.property(money, bps, fc.integer({ min: 0, max: 400 }), fc.constantFrom<"monthly" | "annual">("monthly", "annual"), fc.integer({ min: 0, max: 2000 }), (monthly, disc, credits, interval, leads) => {
        const r = calculatePricing({ plan: { code: "p", name: "P", monthlyPricePaise: monthly, monthlyCredits: credits, annualDiscountBps: disc }, interval, leadsPerMonth: leads });
        for (const n of [r.exGstPaise, r.gstPaise, r.totalPaise, r.monthlyEquivalentPaise]) expect(Number.isSafeInteger(n)).toBe(true);
        expect(r.totalPaise).toBe(r.exGstPaise + r.gstPaise);
        expect(r.totalPaise).toBe(splitGst(r.exGstPaise, r.gstRateBps, true).totalPaise);
        expect(r.monthlyEquivalentPaise * r.periodMonths).toBeLessThanOrEqual(r.totalPaise);
        expect(r.coveredLeadsPerMonth + r.shortfallLeadsPerMonth).toBe(r.leadsPerMonth);
        expect(r.coveredLeadsPerMonth).toBeLessThanOrEqual(credits);
      }),
    );
  });

  it("annual never costs more than 12 monthly payments, and a larger discount never costs more", () => {
    fc.assert(
      fc.property(money, bps, bps, (monthly, d1, d2) => {
        const lo = Math.min(d1, d2);
        const hi = Math.max(d1, d2);
        const a = planPeriodPricePaise({ monthlyPricePaise: monthly, annualDiscountBps: lo }, "annual");
        const b = planPeriodPricePaise({ monthlyPricePaise: monthly, annualDiscountBps: hi }, "annual");
        expect(a).toBeLessThanOrEqual(monthly * 12);
        expect(b).toBeLessThanOrEqual(a);
        const r = calculatePricing({ plan: { code: "p", name: "P", monthlyPricePaise: monthly, monthlyCredits: 1, annualDiscountBps: hi }, interval: "annual", leadsPerMonth: 1 });
        expect(r.annualSavingPaise).toBe(monthly * 12 - b);
      }),
    );
  });

  it("refund is within [0, paid], monotonic in unused months, and refund + kept = paid", () => {
    fc.assert(
      fc.property(money, fc.integer({ min: 0, max: 12 }), fc.integer({ min: 0, max: 12 }), (paid, u1, u2) => {
        const lo = Math.min(u1, u2);
        const hi = Math.max(u1, u2);
        const rLo = annualRefundPaise(paid, lo);
        const rHi = annualRefundPaise(paid, hi);
        expect(rLo).toBeGreaterThanOrEqual(0);
        expect(rHi).toBeLessThanOrEqual(paid);
        expect(rLo).toBeLessThanOrEqual(rHi);
        expect(annualRefundPaise(paid, 12)).toBe(paid);
        expect(annualRefundPaise(paid, 0)).toBe(0);
      }),
    );
  });

  it("used months stay in 1..12 and never decrease as time passes", () => {
    const start = new Date("2026-01-31T00:00:00Z");
    fc.assert(
      fc.property(fc.integer({ min: -30, max: 800 }), fc.integer({ min: 0, max: 60 }), (days, more) => {
        const t1 = new Date(start.getTime() + days * 86_400_000);
        const t2 = new Date(t1.getTime() + more * 86_400_000);
        const u1 = usedMonths(start, t1);
        const u2 = usedMonths(start, t2);
        expect(u1).toBeGreaterThanOrEqual(1);
        expect(u2).toBeLessThanOrEqual(12);
        expect(u2).toBeGreaterThanOrEqual(u1);
        expect(unusedFullMonths(start, t1) + u1).toBe(12);
      }),
    );
  });

  it("addMonths keeps the calendar month arithmetic exact", () => {
    fc.assert(
      fc.property(fc.date({ min: new Date("2020-01-01"), max: new Date("2040-12-31"), noInvalidDate: true }), fc.integer({ min: 0, max: 24 }), (d, n) => {
        const out = addMonths(d, n);
        const months = (out.getUTCFullYear() - d.getUTCFullYear()) * 12 + out.getUTCMonth() - d.getUTCMonth();
        expect(months).toBe(n);
        expect(out.getUTCDate()).toBeLessThanOrEqual(d.getUTCDate());
        expect(out.getTime()).toBeGreaterThanOrEqual(d.getTime());
      }),
    );
  });
});
