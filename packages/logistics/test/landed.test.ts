import { beforeEach, describe, expect, it, vi } from "vitest";

const listing = vi.hoisted(() => ({
  id: "11111111-1111-4111-8111-111111111111",
  sellerBusinessId: "22222222-2222-4222-8222-222222222222",
  pricePaise: 1000,
  priceUnit: "piece",
  priceTiers: [{ minQty: 100, pricePaise: 900 }],
  trade: { unitWeightGrams: 500 } as Record<string, number>,
}));
vi.mock("@cnote/catalogue", () => ({
  getPublicListing: vi.fn(async (id: string) => (id === listing.id ? listing : null)),
  getSellerShippingFacts: vi.fn(async () => ({ listingId: listing.id, unitWeightGrams: 500, unitLengthMm: null, unitWidthMm: null, unitHeightMm: null })),
}));
vi.mock("@cnote/identity", () => ({
  getTrustProfiles: vi.fn(async (ids: string[]) => new Map(ids.map((i) => [i, { pincode: "110001" }]))),
}));

const { estimateForListing, landedForQuotes, quoteLanded, unitPriceAt, ASSUMED_GOODS_GST_BPS } = await import("../src");

describe("quoteLanded", () => {
  it("uses the seller's charge as is when GST is included", () => {
    expect(quoteLanded({ goodsPaise: 100_000, gstIncluded: true, deliveryChargePaise: 5000, estimate: { lowPaise: 1, highPaise: 2 }, freightGstBps: 1800 })).toMatchObject({ lowPaise: 105_000, highPaise: 105_000, freightSource: "quoted", goodsGstPaise: 0, complete: true });
  });
  it("adds assumed goods GST and GST on freight when the seller says GST is extra", () => {
    const r = quoteLanded({ goodsPaise: 100_000, gstIncluded: false, deliveryChargePaise: 10_000, estimate: null, freightGstBps: 1800 });
    expect(ASSUMED_GOODS_GST_BPS).toBe(1800);
    expect(r).toMatchObject({ goodsGstPaise: 18_000, goodsGstAssumed: true, lowPaise: 100_000 + 18_000 + 11_800 });
  });
  it("falls back to the estimate range (with GST) and flags unknown GST", () => {
    const r = quoteLanded({ goodsPaise: 100_000, gstIncluded: null, deliveryChargePaise: null, estimate: { lowPaise: 10_000, highPaise: 20_000 }, freightGstBps: 1800 });
    expect(r).toMatchObject({ freightSource: "estimated", lowPaise: 111_800, highPaise: 123_600, gstUnknown: true, complete: true });
  });
  it("is incomplete with neither a charge nor an estimate", () => {
    expect(quoteLanded({ goodsPaise: 5000, gstIncluded: true, deliveryChargePaise: null, estimate: null, freightGstBps: 1800 })).toMatchObject({ freightSource: "none", complete: false, lowPaise: 5000 });
  });
});

describe("estimateForListing", () => {
  beforeEach(() => vi.clearAllMocks());
  it("is tier-aware, never returns the seller's pincode, and builds a landed range", async () => {
    expect(unitPriceAt(listing, 99)).toBe(1000);
    expect(unitPriceAt(listing, 100)).toBe(900);
    const r = await estimateForListing(listing.id, 200, "400001");
    expect(r.unitPricePaise).toBe(900);
    expect(r.goodsPaise).toBe(180_000);
    expect(r.estimate.estimateOnly).toBe(true);
    expect(r.estimate.zone).toBe("metro");
    expect(r.estimate.assumptions).not.toContain("weight_default");
    expect(JSON.stringify(r)).not.toContain("110001");
    expect(r.landed!.high.totalPaise).toBeGreaterThan(r.landed!.low.totalPaise);
    expect(r.landed!.low.totalPaise).toBeGreaterThan(180_000);
  });
  it("404s for a non-public listing and honours the kill switch", async () => {
    await expect(estimateForListing("33333333-3333-4333-8333-333333333333", 1, "400001")).rejects.toMatchObject({ code: "not_found" });
    process.env.FREIGHT_ESTIMATOR_ENABLED = "false";
    try {
      await expect(estimateForListing(listing.id, 1, "400001")).rejects.toMatchObject({ code: "not_found" });
    } finally {
      delete process.env.FREIGHT_ESTIMATOR_ENABLED;
    }
  });
});

describe("landedForQuotes", () => {
  const base = { sellerBusinessId: listing.sellerBusinessId, quantity: 100, goodsPaise: 100_000 };
  it("estimates only where the seller stated no charge and the terms are not ex-works / pickup", async () => {
    const m = await landedForQuotes([
      { key: "stated", ...base, gstIncluded: true, deliveryChargePaise: 7000, deliveryTerms: "door_delivery" },
      { key: "unstated", ...base, gstIncluded: true, deliveryChargePaise: null, deliveryTerms: "door_delivery" },
      { key: "exw", ...base, gstIncluded: true, deliveryChargePaise: null, deliveryTerms: "ex_works" },
    ], "400001", null);
    expect(m.get("stated")).toMatchObject({ freightSource: "quoted", lowPaise: 107_000, estimate: null });
    expect(m.get("unstated")).toMatchObject({ freightSource: "estimated" });
    expect(m.get("unstated")!.lowPaise).toBeGreaterThan(100_000);
    expect(m.get("exw")).toMatchObject({ freightSource: "quoted", lowPaise: 100_000 });
  });
  it("without a delivery pincode nothing is estimated", async () => {
    const m = await landedForQuotes([{ key: "a", ...base, gstIncluded: null, deliveryChargePaise: null, deliveryTerms: null }], null, null);
    expect(m.get("a")).toMatchObject({ freightSource: "none", complete: false });
  });
});
