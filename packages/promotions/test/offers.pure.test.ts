import { describe, expect, it } from "vitest";
import { assessOffer, discountBpsFrom, offerInputSchema, percentOff, shownReference, type AssessCtx } from "../src/index";

const L = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-09-30T00:00:00Z");
const ctx = (o: Partial<AssessCtx> = {}): AssessCtx => ({ basePricePaise: 10_000, moq: 10, referencePaise: 10_000, floorPaise: 100, startsAt: now, endsAt: new Date(now.getTime() + 7 * 86_400_000), ...o });
const timed = (unitPricePaise: number) => offerInputSchema.parse({ kind: "timed_price", listingId: L, terms: { unitPricePaise }, endsAt: new Date(now.getTime() + 7 * 86_400_000) });
const tiers = (t: [number, number][]) => offerInputSchema.parse({ kind: "volume_tiers", listingId: L, terms: { tiers: t.map(([minQty, unitPricePaise]) => ({ minQty, unitPricePaise })) } });

describe("discount maths", () => {
  it("rounds down and is null without a reference above the price", () => {
    expect(discountBpsFrom(10_000, 8_000)).toBe(2000);
    expect(discountBpsFrom(10_000, 6_667)).toBe(3333); // 33.33% -> floor
    expect(percentOff(3333)).toBe(33);
    expect(percentOff(2999)).toBe(29);
    expect(discountBpsFrom(null, 100)).toBeNull();
    expect(discountBpsFrom(100, 100)).toBeNull();
    expect(discountBpsFrom(100, 150)).toBeNull();
  });
  it("shown reference can never exceed the true 30-day low", () => {
    for (const [a, b] of [[100, 80], [80, 100], [90, 90]] as const) expect(shownReference(a, b)).toBeLessThanOrEqual(Math.min(a, b));
    expect(shownReference(null, 80)).toBeNull();
    expect(shownReference(100, null)).toBeNull();
  });
});

describe("timed price validation matrix", () => {
  it("accepts a clean 20% offer", () => {
    expect(assessOffer(timed(8_000), ctx())).toMatchObject({ errors: [], flags: [], discountBps: 2000 });
  });
  it("rejects price >= listing price", () => {
    expect(assessOffer(timed(10_000), ctx()).errors[0]).toMatch(/below the current listing price/);
    expect(assessOffer(timed(12_000), ctx()).errors[0]).toMatch(/below the current listing price/);
  });
  it("rejects < 3% and accepts exactly 3%", () => {
    expect(assessOffer(timed(9_800), ctx()).errors[0]).toMatch(/at least 3%/);
    expect(assessOffer(timed(9_700), ctx()).errors).toEqual([]);
  });
  it("holds > 50% for review and flags below the floor", () => {
    expect(assessOffer(timed(4_900), ctx()).flags).toContain("deep_discount");
    expect(assessOffer(timed(5_000), ctx()).flags).not.toContain("deep_discount");
    expect(assessOffer(timed(50), ctx()).flags).toEqual(expect.arrayContaining(["deep_discount", "below_floor"]));
  });
  it("measures against the honest reference, not a recently raised price", () => {
    // listing raised to 10000 but was 8000 within 30 days: 9000 is below the base yet NOT a real discount
    expect(assessOffer(timed(9_000), ctx({ referencePaise: 8_000 })).errors[0]).toMatch(/lowest price of the last 30 days/);
    expect(assessOffer(timed(7_000), ctx({ referencePaise: 8_000 }))).toMatchObject({ errors: [], discountBps: 1250 });
  });
  it("no reference (short history): validated against base, discountBps null so no strike-through is ever produced", () => {
    expect(assessOffer(timed(8_000), ctx({ referencePaise: null }))).toMatchObject({ errors: [], discountBps: null });
  });
  it("duration: min 1h, max 30 days", () => {
    const end = (ms: number) => ctx({ endsAt: new Date(now.getTime() + ms) });
    expect(assessOffer(timed(8_000), end(30 * 60_000)).errors[0]).toMatch(/at least one hour/);
    expect(assessOffer(timed(8_000), end(30 * 86_400_000)).errors).toEqual([]);
    expect(assessOffer(timed(8_000), end(31 * 86_400_000)).errors[0]).toMatch(/at most 30 days/);
  });
  it("needs a listing price", () => {
    expect(assessOffer(timed(8_000), ctx({ basePricePaise: null, referencePaise: null })).errors[0]).toMatch(/no price/);
  });
});

describe("volume tier validation matrix", () => {
  it("accepts strictly increasing qty, strictly decreasing price, below base, first >= MOQ", () => {
    expect(assessOffer(tiers([[10, 9_000], [50, 8_000], [100, 7_000]]), ctx()).errors).toEqual([]);
  });
  it("rejects first tier below MOQ", () => expect(assessOffer(tiers([[5, 9_000]]), ctx()).errors[0]).toMatch(/minimum order quantity/));
  it("rejects non-increasing quantity and non-decreasing price", () => {
    expect(assessOffer(tiers([[10, 9_000], [10, 8_000]]), ctx()).errors).toContain("Tier quantities must strictly increase.");
    expect(assessOffer(tiers([[10, 9_000], [20, 9_000]]), ctx()).errors).toContain("Tier prices must strictly decrease as quantity grows.");
    expect(assessOffer(tiers([[10, 9_000], [20, 9_500]]), ctx()).errors).toContain("Tier prices must strictly decrease as quantity grows.");
  });
  it("rejects a tier at or above the listing price", () => expect(assessOffer(tiers([[10, 10_000]]), ctx()).errors[0]).toMatch(/below the listing price/));
  it("max 5 tiers (schema)", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ minQty: 10 + i, unitPricePaise: 9_000 - i }));
    expect(offerInputSchema.safeParse({ kind: "volume_tiers", listingId: L, terms: { tiers: six } }).success).toBe(false);
  });
  it("flags a > 50% deepest tier", () => expect(assessOffer(tiers([[10, 9_000], [500, 3_000]]), ctx()).flags).toContain("deep_discount"));
  it("best tier discount is relative to the reference", () => expect(assessOffer(tiers([[10, 9_000], [50, 8_000]]), ctx()).discountBps).toBe(2000));
});

describe("free delivery validation", () => {
  const fd = (terms: object) => offerInputSchema.safeParse({ kind: "free_delivery_moq", listingId: L, terms });
  it("needs minQty or minOrderValue", () => expect(fd({}).success).toBe(false));
  it("accepts value-only and regions", () => expect(fd({ minOrderValuePaise: 500_000, regions: ["Karnataka"] }).success).toBe(true));
  it("minQty must be >= MOQ", () => {
    const p = offerInputSchema.parse({ kind: "free_delivery_moq", listingId: L, terms: { minQty: 5 } });
    expect(assessOffer(p, ctx({ endsAt: null })).errors[0]).toMatch(/minimum order quantity/);
    expect(assessOffer(offerInputSchema.parse({ kind: "free_delivery_moq", listingId: L, terms: { minQty: 500 } }), ctx({ endsAt: null })).errors).toEqual([]);
  });
});

describe("schema hygiene", () => {
  it("has no field where a seller could supply a reference / original price", () => {
    const r = offerInputSchema.safeParse({ kind: "timed_price", listingId: L, terms: { unitPricePaise: 8_000, referencePricePaise: 99_999, originalPricePaise: 99_999 }, endsAt: new Date(now.getTime() + 86_400_000) });
    expect(r.success && JSON.stringify(r.data)).not.toMatch(/99999/);
  });
});
