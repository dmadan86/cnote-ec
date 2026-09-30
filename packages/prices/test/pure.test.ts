import { describe, expect, it } from "vitest";
import { normaliseFact, normaliseUnit, tierOf } from "../src/units";
import { REGION_SLUGS, regionLabel, stateFromPincode, stateSlug } from "../src/regions";
import { interpolated, quantilesOf, trimOutliers, weightedPercentile } from "../src/stats";
import { clampK, escrowWeight, priceIntelEnabled } from "../src/config";
import { positionOf, trendOf } from "../src/read";
import { periodOf, toSamples } from "../src/run";
import type { PriceFact } from "@cnote/enquiry";

describe("units", () => {
  it("normalises convertible units to a canonical unit", () => {
    expect(normaliseFact(500_000, 2, "tonne")).toEqual({ unit: "kg", price: 500, quantity: 2000, factor: 1000 });
    expect(normaliseFact(1200, 3, " Dozen ")).toMatchObject({ unit: "pcs", price: 100, quantity: 36 });
    expect(normaliseFact(10, 5, "kg")).toMatchObject({ unit: "kg", price: 10 });
    expect(normaliseFact(100, 1, "sets")).toMatchObject({ unit: "set" });
  });
  it("skips non-comparable or invalid inputs", () => {
    expect(normaliseUnit("parsec")).toBeNull();
    expect(normaliseUnit(null)).toBeNull();
    expect(normaliseFact(100, 1, "parsec")).toBeNull();
    expect(normaliseFact(0, 1, "kg")).toBeNull();
    expect(normaliseFact(100, 0, "kg")).toBeNull();
    expect(normaliseFact(1, 1, "quintal")).toBeNull(); // rounds to 0 paise per kg
  });
  it("assigns quantity tiers per unit", () => {
    expect(tierOf("kg", 99)).toBe("t1");
    expect(tierOf("kg", 100)).toBe("t2");
    expect(tierOf("kg", 1000)).toBe("t3");
    expect(tierOf("l", 49)).toBe("t1");
    expect(tierOf("set", 10)).toBe("t2");
    expect(tierOf("set", 100)).toBe("t3");
  });
});

describe("regions", () => {
  it("maps PINs to states with overrides", () => {
    expect(stateFromPincode("400001")).toBe("maharashtra");
    expect(stateFromPincode("403001")).toBe("goa");
    expect(stateFromPincode("110001")).toBe("delhi");
    expect(stateFromPincode("248001")).toBe("uttarakhand");
    expect(stateFromPincode("226001")).toBe("uttar-pradesh");
    expect(stateFromPincode("834001")).toBe("jharkhand");
    expect(stateFromPincode("800001")).toBe("bihar");
    expect(stateFromPincode("560001")).toBe("karnataka");
  });
  it("rejects malformed or unmapped PINs", () => {
    for (const p of [null, undefined, "", "12345", "0123456", "abcdef", "990000"]) expect(stateFromPincode(p)).toBeNull();
  });
  it("slugs and labels states", () => {
    expect(stateSlug("Tamil Nadu")).toBe("tamil-nadu");
    expect(stateSlug("Jammu & Kashmir")).toBe("jammu-and-kashmir");
    expect(stateSlug("Narnia")).toBeNull();
    expect(stateSlug(null)).toBeNull();
    expect(REGION_SLUGS.has("goa")).toBe(true);
    expect(regionLabel("national")).toBe("India");
    expect(regionLabel("jammu-and-kashmir")).toBe("Jammu and Kashmir");
  });
});

describe("stats", () => {
  const w = (...v: number[]) => v.map((value) => ({ value, weight: 1 }));
  it("nearest-rank percentiles with unit weights", () => {
    const q = quantilesOf(w(1, 2, 3, 4, 5, 6, 7, 8, 9, 10));
    expect(q).toEqual({ p10: 1, p25: 3, p50: 5, p75: 8, p90: 9 });
  });
  it("heavier weights pull percentiles toward them", () => {
    expect(weightedPercentile([{ value: 1, weight: 1 }, { value: 100, weight: 9 }], 0.5)).toBe(100);
    expect(weightedPercentile([{ value: 1, weight: 1 }, { value: 100, weight: 1 }], 0)).toBe(1);
    expect(() => weightedPercentile([], 0.5)).toThrow();
  });
  it("trims IQR outliers only with enough samples", () => {
    const base = w(10, 11, 12, 10, 11, 12, 11, 10);
    expect(trimOutliers([...base, { value: 1000, weight: 1 }]).map((x) => x.value)).not.toContain(1000);
    expect(trimOutliers([...w(10, 11), { value: 1000, weight: 1 }])).toHaveLength(3);
    expect(trimOutliers(w(5, 5, 5, 5, 5, 5, 5, 5))).toHaveLength(8);
    expect(interpolated([1, 3], 0.5)).toBe(2);
  });
});

describe("config and read helpers", () => {
  it("flag and clamp", () => {
    expect(priceIntelEnabled({ PRICE_INTEL_ENABLED: "on" })).toBe(true);
    expect(priceIntelEnabled({})).toBe(false);
    expect(clampK(1)).toBe(3);
    expect(clampK(1000)).toBe(100);
    expect(clampK(7.9)).toBe(7);
    expect(escrowWeight({ PRICE_ESCROW_WEIGHT: "5" })).toBe(5);
    expect(escrowWeight({ PRICE_ESCROW_WEIGHT: "0" })).toBe(3);
    expect(escrowWeight({})).toBe(3);
  });
  it("position and trend", () => {
    expect(positionOf(90, 100, 200)).toBe("below");
    expect(positionOf(100, 100, 200)).toBe("within");
    expect(positionOf(201, 100, 200)).toBe("above");
    expect(trendOf(null)).toBe("unknown");
    expect(trendOf(500)).toBe("up");
    expect(trendOf(-500)).toBe("down");
    expect(trendOf(100)).toBe("flat");
  });
  it("period labels", () => expect(periodOf(new Date("2026-09-30T10:00:00Z"))).toBe("2026-09"));
});

describe("toSamples", () => {
  const fact = (o: Partial<PriceFact>): PriceFact => ({
    id: "f", source: "quote", escrow: false, quoteId: null, categoryId: "c", pricePaise: 100, quantity: 1, unit: "kg", deliveryPincode: "400001", deliveryCity: null,
    createdAt: new Date(), sellerBusinessId: "s", buyerBusinessId: "b", ...o,
  });
  it("drops a quote superseded by its order, skips unknown units, maps region", () => {
    const { samples, skippedUnits } = toSamples([
      fact({ id: "q1" }), fact({ id: "o1", source: "order", escrow: true, quoteId: "q1" }), fact({ id: "q2", unit: "parsec" }), fact({ id: "q3", deliveryPincode: null }),
    ]);
    expect(skippedUnits).toBe(1);
    expect(samples).toHaveLength(2);
    expect(samples.find((s) => s.escrow)?.region).toBe("maharashtra");
    expect(samples.find((s) => !s.escrow)?.region).toBeNull();
  });
});
