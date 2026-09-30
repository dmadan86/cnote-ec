import { describe, expect, it } from "vitest";
import {
  buyerBoundsProblems, checkBuyerCounter, checkSellerQuote, editStats, fallbackCounter, landedPerUnit, levenshtein, parseTiers, priceBookProblems, rankQuotes, MIN_COUNTER_RATIO,
} from "../src/bounds";

describe("parseTiers", () => {
  it("keeps valid tiers sorted and drops junk", () => {
    expect(parseTiers([{ minQty: 10, pricePaise: 4 }, { minQty: 2, pricePaise: 5 }, { minQty: "x" }, null, 3])).toEqual([{ minQty: 2, pricePaise: 5 }, { minQty: 10, pricePaise: 4 }]);
    expect(parseTiers("nope")).toEqual([]);
  });
});

describe("priceBookProblems", () => {
  const ok = { basePricePaise: 5000, floorPricePaise: 4000, tiers: [{ minQty: 100, pricePaise: 4500 }, { minQty: 500, pricePaise: 4200 }], moq: 10, leadTimeDays: 7, validityDays: 7, gstPercent: 18 };
  it("accepts a sane book", () => expect(priceBookProblems(ok)).toEqual([]));
  it.each([
    ["floor above base", { floorPricePaise: 6000 }, "Floor price cannot be above"],
    ["tier below floor", { tiers: [{ minQty: 10, pricePaise: 3000 }] }, "below your floor"],
    ["tier price rising", { tiers: [{ minQty: 10, pricePaise: 5500 }] }, "cannot cost more"],
    ["non-increasing qty", { tiers: [{ minQty: 10, pricePaise: 4500 }, { minQty: 10, pricePaise: 4400 }] }, "increasing quantities"],
    ["tiny qty", { tiers: [{ minQty: 1, pricePaise: 4500 }] }, "quantity of 2"],
    ["bad tier price", { tiers: [{ minQty: 5, pricePaise: 0 }] }, "positive price"],
    ["bad base", { basePricePaise: 0 }, "Base price"],
    ["bad floor", { floorPricePaise: -1 }, "Floor price must"],
    ["bad moq", { moq: 0 }, "MOQ"],
    ["bad lead", { leadTimeDays: 400 }, "Lead time"],
    ["bad validity", { validityDays: 0 }, "Validity"],
    ["bad gst", { gstPercent: 90 }, "GST"],
  ])("rejects %s", (_n, over, msg) => {
    expect(priceBookProblems({ ...ok, ...over }).join(" ")).toContain(msg);
  });
});

describe("checkSellerQuote", () => {
  it("passes at and above the floor, fails below", () => {
    expect(checkSellerQuote({ pricePaise: 4000, quantity: 1 }, { floorPricePaise: 4000 }).ok).toBe(true);
    expect(checkSellerQuote({ pricePaise: 3999, quantity: 1 }, { floorPricePaise: 4000 })).toEqual({ ok: false, violations: ["Price is below your floor price."] });
  });
  it("rejects null, fractional, negative prices and bad quantity", () => {
    expect(checkSellerQuote({ pricePaise: null, quantity: 1 }, { floorPricePaise: 1 }).violations).toContain("No price.");
    expect(checkSellerQuote({ pricePaise: 10.5, quantity: 1 }, { floorPricePaise: 1 }).ok).toBe(false);
    expect(checkSellerQuote({ pricePaise: -5, quantity: 1 }, { floorPricePaise: 1 }).ok).toBe(false);
    expect(checkSellerQuote({ pricePaise: 10, quantity: 0 }, { floorPricePaise: 1 }).ok).toBe(false);
  });
  it("optionally enforces a minimum lead time", () => {
    expect(checkSellerQuote({ pricePaise: 10, quantity: 1, leadTimeDays: 2 }, { floorPricePaise: 1, minLeadTimeDays: 5 }).ok).toBe(false);
    expect(checkSellerQuote({ pricePaise: 10, quantity: 1, leadTimeDays: 5 }, { floorPricePaise: 1, minLeadTimeDays: 5 }).ok).toBe(true);
    expect(checkSellerQuote({ pricePaise: 10, quantity: 1, leadTimeDays: null }, { floorPricePaise: 1, minLeadTimeDays: 5 }).ok).toBe(true);
  });
});

describe("buyer bounds + counters", () => {
  const b = { targetPricePaise: 4500, ceilingPricePaise: 4800, maxLeadTimeDays: 10 };
  it("validates bounds", () => {
    expect(buyerBoundsProblems(b)).toEqual([]);
    expect(buyerBoundsProblems({ ...b, targetPricePaise: 5000 })[0]).toContain("Target price cannot be above");
    expect(buyerBoundsProblems({ ...b, targetPricePaise: 0 }).length).toBeGreaterThan(0);
    expect(buyerBoundsProblems({ ...b, ceilingPricePaise: -1 }).length).toBeGreaterThan(0);
    expect(buyerBoundsProblems({ ...b, maxLeadTimeDays: 0 }).length).toBeGreaterThan(0);
    expect(buyerBoundsProblems({ targetPricePaise: null, ceilingPricePaise: null, maxLeadTimeDays: null })).toEqual([]);
  });
  it("accepts an in-bounds counter", () => expect(checkBuyerCounter({ pricePaise: 4600, leadTimeDays: 9 }, { pricePaise: 5000 }, b).ok).toBe(true));
  it.each([
    ["not below the quote", { pricePaise: 5000, leadTimeDays: null }, "below the quoted"],
    ["above the ceiling", { pricePaise: 4900, leadTimeDays: null }, "above your maximum"],
    ["lowball", { pricePaise: 2000, leadTimeDays: null }, "50% below"],
    ["lead too long", { pricePaise: 4600, leadTimeDays: 30 }, "longer than your limit"],
    ["lead zero", { pricePaise: 4600, leadTimeDays: 0 }, "1 day"],
    ["fractional price", { pricePaise: 4600.5, leadTimeDays: null }, "whole number"],
  ])("rejects %s", (_n, c, msg) => expect(checkBuyerCounter(c, { pricePaise: 5000 }, b).violations.join(" ")).toContain(msg));
  it("the lowball boundary is exactly the ratio", () => {
    const lo = Math.ceil(5000 * MIN_COUNTER_RATIO);
    const open = { targetPricePaise: null, ceilingPricePaise: null, maxLeadTimeDays: null };
    expect(checkBuyerCounter({ pricePaise: lo, leadTimeDays: null }, { pricePaise: 5000 }, open).ok).toBe(true);
    expect(checkBuyerCounter({ pricePaise: lo - 1, leadTimeDays: null }, { pricePaise: 5000 }, open).ok).toBe(false);
  });
  it("fallbackCounter aims at the target, clamps, and gives up when no range exists", () => {
    expect(fallbackCounter({ pricePaise: 5000, leadTimeDays: 14 }, b)).toEqual({ pricePaise: 4500, leadTimeDays: 10 });
    expect(fallbackCounter({ pricePaise: 5000, leadTimeDays: null }, { targetPricePaise: null, ceilingPricePaise: null, maxLeadTimeDays: null })).toEqual({ pricePaise: 4750, leadTimeDays: null });
    expect(fallbackCounter({ pricePaise: 5000, leadTimeDays: 5 }, { targetPricePaise: 1000, ceilingPricePaise: null, maxLeadTimeDays: 10 })).toEqual({ pricePaise: 2500, leadTimeDays: null });
    expect(fallbackCounter({ pricePaise: 5000, leadTimeDays: 5 }, { targetPricePaise: null, ceilingPricePaise: 1000, maxLeadTimeDays: null })).toBeNull();
    expect(fallbackCounter({ pricePaise: 1, leadTimeDays: null }, b)).toBeNull();
  });
});

describe("landedPerUnit", () => {
  const base = { pricePaise: 10000, quantity: 100, deliveryChargePaise: null, deliveryIncluded: null, gstPercent: null, gstIncluded: null };
  it("flags unknown delivery and GST and does not guess", () => {
    expect(landedPerUnit(base)).toEqual({ landedPaise: 10000, complete: false, assumptions: ["delivery_unknown", "gst_unknown"] });
  });
  it("adds freight per unit and GST on top when stated extra", () => {
    const r = landedPerUnit({ ...base, deliveryChargePaise: 200000, deliveryIncluded: false, gstPercent: 18, gstIncluded: false });
    expect(r.landedPaise).toBe(Math.round((10000 + 2000) * 1.18));
    expect(r.complete).toBe(true);
  });
  it("treats included delivery and GST as complete with no additions", () => {
    expect(landedPerUnit({ ...base, deliveryIncluded: true, deliveryChargePaise: 0, gstIncluded: true, gstPercent: 18 })).toEqual({ landedPaise: 10000, complete: true, assumptions: [] });
    expect(landedPerUnit({ ...base, deliveryIncluded: true, gstIncluded: true }).complete).toBe(true);
  });
  it("GST percent without an included flag stays unknown", () => {
    expect(landedPerUnit({ ...base, gstPercent: 18 }).assumptions).toContain("gst_unknown");
  });
});

describe("rankQuotes", () => {
  const row = (key: string, landedPaise: number, leadTimeDays: number | null, verificationTier = 1, expired = false) => ({ key, landedPaise, leadTimeDays, verificationTier, expired });
  it("finds best price, fastest and a weighted best value", () => {
    const r = rankQuotes([row("cheap", 900, 30, 0), row("fast", 1100, 3, 1), row("balanced", 950, 7, 3)]);
    expect(r).toEqual({ bestPrice: "cheap", fastest: "fast", bestValue: "balanced" });
  });
  it("ignores expired quotes and handles empty / single rows / missing lead times", () => {
    expect(rankQuotes([])).toEqual({ bestPrice: null, fastest: null, bestValue: null });
    expect(rankQuotes([row("a", 1, 1, 0, true)])).toEqual({ bestPrice: null, fastest: null, bestValue: null });
    expect(rankQuotes([row("a", 500, null), row("b", 400, null, 1, true)])).toEqual({ bestPrice: "a", fastest: null, bestValue: "a" });
    expect(rankQuotes([row("a", 500, 5), row("b", 500, 5)]).bestValue).toBe("a"); // stable tie-break
    expect(rankQuotes([row("a", 500, 5), row("b", 600, null)]).bestValue).toBe("a");
  });
});

describe("edit distance + stats", () => {
  it("levenshtein basics", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("same", "same")).toBe(0);
  });
  it("editStats counts changed fields, price delta and notes distance", () => {
    const o = { pricePaise: 1000, quantity: 10, unit: "pcs", leadTimeDays: 5, shippingTerms: null, validUntil: "2026-10-10", notes: "GST extra" };
    expect(editStats(o, o)).toEqual({ editedFields: 0, priceDeltaPct: 0, notesEditDistance: 0 });
    const s = editStats(o, { ...o, pricePaise: 900, notes: "GST extra, freight extra", leadTimeDays: 3 });
    expect(s.editedFields).toBe(3);
    expect(s.priceDeltaPct).toBeCloseTo(-10);
    expect(s.notesEditDistance).toBe(15);
    expect(editStats({ ...o, pricePaise: 0 }, o).priceDeltaPct).toBeNull();
    expect(editStats({ ...o, notes: null }, { ...o, notes: "" }).editedFields).toBe(1);
  });
});
