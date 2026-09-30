import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buyerBoundsProblems, checkBuyerCounter, checkSellerQuote, editStats, fallbackCounter, landedPerUnit, levenshtein, MIN_COUNTER_RATIO, priceBookProblems, rankQuotes } from "../src/bounds";

const paise = fc.integer({ min: 1, max: 10_000_000 });
const opt = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: null });
const boundsArb = fc.record({ targetPricePaise: opt(paise), ceilingPricePaise: opt(paise), maxLeadTimeDays: opt(fc.integer({ min: 1, max: 365 })) }).filter((b) => buyerBoundsProblems(b).length === 0);

describe("seller floor (server-side)", () => {
  it("accepts a price iff it is a positive integer at or above the floor", () => {
    fc.assert(fc.property(fc.oneof(fc.integer({ min: -100, max: 20_000_000 }), fc.double({ noNaN: true, min: -10, max: 1e7 }), fc.constant(null)), paise, fc.integer({ min: 1, max: 1000 }), (price, floor, qty) => {
      const r = checkSellerQuote({ pricePaise: price, quantity: qty }, { floorPricePaise: floor });
      const expected = price !== null && Number.isSafeInteger(price) && price > 0 && price >= floor;
      expect(r.ok).toBe(expected);
      expect(r.ok).toBe(r.violations.length === 0);
    }), { numRuns: 500 });
  });
  it("a price book that passes validation never has a tier below the floor or rising with quantity", () => {
    fc.assert(fc.property(paise, paise, fc.array(fc.record({ minQty: fc.integer({ min: -5, max: 5000 }), pricePaise: fc.integer({ min: -5, max: 10_000_000 }) }), { maxLength: 6 }), (base, floor, tiers) => {
      const book = { basePricePaise: base, floorPricePaise: floor, tiers };
      if (priceBookProblems(book).length) return;
      expect(floor).toBeLessThanOrEqual(base);
      const sorted = tiers;
      let prev = base;
      let prevQty = 0;
      for (const t of sorted) {
        expect(t.pricePaise).toBeGreaterThanOrEqual(floor);
        expect(t.pricePaise).toBeLessThanOrEqual(prev);
        expect(t.minQty).toBeGreaterThan(prevQty);
        prev = t.pricePaise; prevQty = t.minQty;
      }
    }), { numRuns: 500 });
  });
});

describe("buyer bounds (server-side)", () => {
  it("any accepted counter is below the quote, within ceiling and lead limit, and not a lowball", () => {
    fc.assert(fc.property(boundsArb, paise, fc.integer({ min: -10, max: 20_000_000 }), opt(fc.integer({ min: -5, max: 800 })), (b, quote, price, lead) => {
      const r = checkBuyerCounter({ pricePaise: price, leadTimeDays: lead }, { pricePaise: quote }, b);
      if (!r.ok) return;
      expect(price).toBeLessThan(quote);
      expect(price).toBeGreaterThanOrEqual(Math.ceil(quote * MIN_COUNTER_RATIO));
      if (b.ceilingPricePaise != null) expect(price).toBeLessThanOrEqual(b.ceilingPricePaise);
      if (lead != null) { expect(lead).toBeGreaterThanOrEqual(1); if (b.maxLeadTimeDays != null) expect(lead).toBeLessThanOrEqual(b.maxLeadTimeDays); }
    }), { numRuns: 1000 });
  });
  it("rejects every price above the ceiling and every price at or above the quote", () => {
    fc.assert(fc.property(boundsArb.filter((b) => b.ceilingPricePaise != null), paise, fc.integer({ min: 1, max: 1000 }), (b, quote, over) => {
      expect(checkBuyerCounter({ pricePaise: b.ceilingPricePaise! + over, leadTimeDays: null }, { pricePaise: quote }, b).ok).toBe(false);
      expect(checkBuyerCounter({ pricePaise: quote + over - 1, leadTimeDays: null }, { pricePaise: quote }, b).ok).toBe(false);
    }));
  });
  it("fallbackCounter output, when it exists, always passes the bounds check (so a bad model output can always be replaced safely)", () => {
    fc.assert(fc.property(boundsArb, paise, opt(fc.integer({ min: 0, max: 400 })), (b, quote, lead) => {
      const fb = fallbackCounter({ pricePaise: quote, leadTimeDays: lead }, b);
      if (!fb) return;
      expect(checkBuyerCounter(fb, { pricePaise: quote }, b).ok).toBe(true);
    }), { numRuns: 1000 });
  });
  it("fallbackCounter is null exactly when no in-range price exists", () => {
    fc.assert(fc.property(boundsArb, paise, (b, quote) => {
      const hi = Math.min(quote - 1, b.ceilingPricePaise ?? Infinity);
      const lo = Math.ceil(quote * MIN_COUNTER_RATIO);
      const exists = hi >= lo && hi >= 1;
      expect(fallbackCounter({ pricePaise: quote, leadTimeDays: null }, b) !== null).toBe(exists);
    }), { numRuns: 500 });
  });
});

describe("comparison maths", () => {
  const termsArb = fc.record({ deliveryChargePaise: opt(fc.integer({ min: 0, max: 1_000_000 })), deliveryIncluded: opt(fc.boolean()), gstPercent: opt(fc.integer({ min: 0, max: 28 })), gstIncluded: opt(fc.boolean()) });
  it("landed price is never below the quoted price (rounding aside) and is monotone in the quoted price", () => {
    fc.assert(fc.property(paise, fc.integer({ min: 1, max: 5000 }), termsArb, fc.integer({ min: 1, max: 1000 }), (price, qty, t, bump) => {
      const a = landedPerUnit({ pricePaise: price, quantity: qty, ...t });
      const b = landedPerUnit({ pricePaise: price + bump, quantity: qty, ...t });
      expect(a.landedPaise).toBeGreaterThanOrEqual(price);
      expect(b.landedPaise).toBeGreaterThanOrEqual(a.landedPaise);
      expect(a.complete).toBe(a.assumptions.length === 0);
      expect(Number.isInteger(a.landedPaise)).toBe(true);
    }), { numRuns: 500 });
  });
  it("the ranked winners exist iff there is a live quote, are never expired, and best price is the minimum", () => {
    const rowArb = fc.record({ key: fc.uuid(), landedPaise: paise, leadTimeDays: opt(fc.integer({ min: 0, max: 200 })), verificationTier: fc.integer({ min: 0, max: 3 }), expired: fc.boolean() });
    fc.assert(fc.property(fc.uniqueArray(rowArb, { selector: (r) => r.key, maxLength: 8 }), (rows) => {
      const r = rankQuotes(rows);
      const live = rows.filter((x) => !x.expired);
      if (!live.length) { expect(r).toEqual({ bestPrice: null, fastest: null, bestValue: null }); return; }
      const byKey = new Map(rows.map((x) => [x.key, x]));
      expect(byKey.get(r.bestPrice!)!.expired).toBe(false);
      expect(byKey.get(r.bestValue!)!.expired).toBe(false);
      expect(byKey.get(r.bestPrice!)!.landedPaise).toBe(Math.min(...live.map((x) => x.landedPaise)));
      if (r.fastest) expect(byKey.get(r.fastest)!.leadTimeDays).toBe(Math.min(...live.filter((x) => x.leadTimeDays != null).map((x) => x.leadTimeDays!)));
    }), { numRuns: 500 });
  });
});

describe("edit distance", () => {
  it("is a metric on short strings and editStats(x, x) is empty", () => {
    fc.assert(fc.property(fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), (a, b, c) => {
      expect(levenshtein(a, b)).toBe(levenshtein(b, a));
      expect(levenshtein(a, b) === 0).toBe(a === b);
      expect(levenshtein(a, c)).toBeLessThanOrEqual(levenshtein(a, b) + levenshtein(b, c));
      const f = { pricePaise: 100, quantity: 1, unit: "pcs", leadTimeDays: null, shippingTerms: null, validUntil: null, notes: a };
      expect(editStats(f, f)).toEqual({ editedFields: 0, priceDeltaPct: 0, notesEditDistance: 0 });
    }), { numRuns: 300 });
  });
});
