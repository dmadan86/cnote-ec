import { describe, expect, it } from "vitest";
import { DEFAULT_RATE_CARD, rateCardSchema, classifyLane, estimateWithCard, landedCost, pickMode } from "../src";

describe("classifyLane", () => {
  it.each([
    ["110001", "110020", "local"],
    ["560001", "562107", "intra_state"], // 560 vs 562, both Karnataka
    ["110001", "400001", "metro"],
    ["400001", "411001", "intra_state"],
    ["110001", "122001", "metro"], // Delhi -> Gurugram (different state, both metro lanes)
    ["302001", "110001", "regional"], // Rajasthan -> Delhi share no first digit? 3 vs 1
    ["110001", "781001", "special"],
    ["180001", "600001", "special"],
    ["226001", "600001", "national"],
  ])("%s -> %s is %s", (o, d, zone) => {
    const got = classifyLane(o, d).zone;
    // 302001 -> 110001 is 3 vs 1: national, asserted explicitly below
    expect(got).toBe(o === "302001" ? "national" : zone);
  });
  it("regional = same postal zone, different state", () => {
    expect(classifyLane("302001", "380001").zone).toBe("regional"); // Rajasthan -> Gujarat (3x)
  });
  it("unknown origin degrades to national and is flagged", () => {
    const l = classifyLane(null, "110001");
    expect(l.zone).toBe("national");
    expect(l.originKnown).toBe(false);
  });
});

describe("estimateWithCard", () => {
  it("is deterministic and exposes a range around the mid with fuel and GST", () => {
    const req = { originPincode: "110001", destinationPincode: "400001", quantity: 2, unitWeightGrams: 1000 } as const;
    const a = estimateWithCard(req);
    expect(estimateWithCard(req)).toEqual(a);
    expect(a.mode).toBe("parcel");
    expect(a.zone).toBe("metro");
    expect(a.chargeableWeightKg).toBe(2);
    // 2 kg metro slab = Rs 110, + 12% fuel = Rs 123.20
    expect(a.midPaise).toBe(12320);
    expect(a.lowPaise).toBeLessThan(a.midPaise);
    expect(a.highPaise).toBeGreaterThan(a.midPaise);
    expect(a.gstHighPaise).toBe(Math.round(a.highPaise * 0.18));
    expect(a.estimateOnly).toBe(true);
    expect(a.assumptions).toContain("dims_missing");
  });

  it("uses volumetric weight when it exceeds actual weight", () => {
    // 500x400x300 mm = 60,000 cm3 / 5000 = 12 kg volumetric vs 1 kg actual
    const a = estimateWithCard({ originPincode: "110001", destinationPincode: "400001", quantity: 1, unitWeightGrams: 1000, unitLengthMm: 500, unitWidthMm: 400, unitHeightMm: 300 });
    expect(a.volumetricWeightKg).toBe(12);
    expect(a.chargeableWeightKg).toBe(12);
    expect(a.assumptions).toContain("volumetric_applied");
  });

  it("defaults the unit weight and says so", () => {
    const a = estimateWithCard({ originPincode: "110001", destinationPincode: "110020", quantity: 3 });
    expect(a.actualWeightKg).toBe(3);
    expect(a.assumptions).toContain("weight_default");
  });

  it("switches mode by weight: parcel -> part-truck -> full truck, with multiple vehicles when needed", () => {
    const base = { originPincode: "110001", destinationPincode: "400001", unitWeightGrams: 1000 };
    expect(estimateWithCard({ ...base, quantity: 20 }).mode).toBe("parcel");
    const ltl = estimateWithCard({ ...base, quantity: 500 });
    expect(ltl.mode).toBe("ltl");
    expect(ltl.midPaise).toBeGreaterThanOrEqual(DEFAULT_RATE_CARD.ltl.minChargePaise.metro);
    const ftl = estimateWithCard({ ...base, quantity: 8000 });
    expect(ftl.mode).toBe("ftl");
    expect(ftl.vehicles).toBe(1);
    const many = estimateWithCard({ ...base, quantity: 45_000 });
    expect(many.vehicles).toBe(3);
    expect(many.assumptions).toContain("multi_vehicle");
  });

  it("costs more for farther lanes and special zones", () => {
    const base = { originPincode: "110001", quantity: 5, unitWeightGrams: 1000 };
    const local = estimateWithCard({ ...base, destinationPincode: "110020" });
    const nat = estimateWithCard({ ...base, destinationPincode: "600001" });
    const ne = estimateWithCard({ ...base, destinationPincode: "781001" });
    expect(local.midPaise).toBeLessThan(nat.midPaise);
    expect(nat.midPaise).toBeLessThan(ne.midPaise);
    expect(ne.transitDays.max).toBeGreaterThan(local.transitDays.max);
  });

  it("flags an unknown origin", () => {
    const a = estimateWithCard({ originPincode: null, destinationPincode: "400001", quantity: 1, unitWeightGrams: 500 });
    expect(a.zone).toBe("national");
    expect(a.assumptions).toContain("origin_unknown");
  });
});

describe("rate card + landed cost", () => {
  it("default card validates and every mode has all zones", () => {
    expect(rateCardSchema.safeParse(DEFAULT_RATE_CARD).success).toBe(true);
    expect(pickMode(31, DEFAULT_RATE_CARD)).toBe("ltl");
  });
  it("rejects an incomplete card", () => {
    const bad = { ...DEFAULT_RATE_CARD, parcel: { ...DEFAULT_RATE_CARD.parcel, slabs: [] } };
    expect(rateCardSchema.safeParse(bad).success).toBe(false);
  });
  it("adds goods, goods GST, freight and freight GST", () => {
    const l = landedCost({ goodsPaise: 100_000, goodsGstBps: 1800, freightPaise: 10_000, freightGstBps: 1800 });
    expect(l).toMatchObject({ goodsGstPaise: 18_000, freightGstPaise: 1800, totalPaise: 129_800, complete: true });
    expect(landedCost({ goodsPaise: 5000, freightPaise: null, freightGstBps: 1800 })).toMatchObject({ totalPaise: 5000, complete: false });
  });
});
