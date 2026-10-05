import { describe, expect, it } from "vitest";
import { compactTrade, parsePriceTiers, parseTrade, tradeOfRow, validatePriceTiers } from "../src/tiers";
import { listingInputSchema } from "../src/validate";
import { diffSnapshots, type VersionSnapshot } from "../src/versions";

describe("validatePriceTiers", () => {
  const t = (minQty: number, pricePaise: number) => ({ minQty, pricePaise });
  it("accepts ascending slabs with non-increasing prices at or above MOQ", () => {
    expect(validatePriceTiers([t(10, 1000), t(100, 900), t(500, 900), t(1000, 800)], 10)).toEqual([]);
    expect(validatePriceTiers([], 10)).toEqual([]);
  });
  it("rejects a first slab below MOQ (or below 1 with no MOQ)", () => {
    expect(validatePriceTiers([t(5, 1000)], 10)[0]).toMatch(/minimum order \(10\)/);
    expect(validatePriceTiers([t(1, 1000)], null)).toEqual([]);
  });
  it("rejects equal/descending quantities and rising prices", () => {
    expect(validatePriceTiers([t(10, 1000), t(10, 900)], 10)[0]).toMatch(/Tier 2: quantity/);
    expect(validatePriceTiers([t(10, 1000), t(5, 900)], 10).join()).toMatch(/Tier 2: quantity/);
    expect(validatePriceTiers([t(10, 1000), t(50, 1001)], 10)[0]).toMatch(/Tier 2: price/);
  });
  it("caps the number of slabs", () => {
    const many = Array.from({ length: 9 }, (_, i) => t(10 + i, 1000 - i));
    expect(validatePriceTiers(many, 10)[0]).toMatch(/At most 8/);
  });
});

describe("parsing + trade info", () => {
  it("parsePriceTiers drops malformed rows", () => {
    expect(parsePriceTiers([{ minQty: 10, pricePaise: 5 }, { minQty: 0, pricePaise: 5 }, "x", { minQty: 3.5, pricePaise: 1 }])).toEqual([{ minQty: 10, pricePaise: 5 }]);
    expect(parsePriceTiers(null)).toEqual([]);
  });
  it("compactTrade keeps only present fields; sample price needs sampleAvailable", () => {
    expect(compactTrade({ leadTimeDays: null, packaging: "", sampleAvailable: false, samplePricePaise: 500, certifications: [] })).toEqual({});
    expect(compactTrade({ leadTimeDays: 0, sampleAvailable: true, samplePricePaise: 500, certifications: ["ISO 9001"] })).toEqual({ leadTimeDays: 0, sampleAvailable: true, samplePricePaise: 500, certifications: ["ISO 9001"] });
    expect(parseTrade("junk")).toEqual({});
  });
  it("sample workflow settings (max qty, dispatch days, minimum buyer tier) are kept only when samples are offered, and a zero tier is dropped", () => {
    expect(compactTrade({ sampleAvailable: false, sampleMaxQty: 5, sampleDispatchDays: 2, sampleMinBuyerTier: 2 })).toEqual({});
    expect(compactTrade({ sampleAvailable: true, sampleMaxQty: 5, sampleDispatchDays: 0, sampleMinBuyerTier: 0 })).toEqual({ sampleAvailable: true, sampleMaxQty: 5, sampleDispatchDays: 0 });
    expect(parseTrade({ sampleAvailable: true, sampleMinBuyerTier: 2, sampleMaxQty: 9 })).toEqual({ sampleAvailable: true, sampleMinBuyerTier: 2, sampleMaxQty: 9 });
    expect(parseTrade({ sampleAvailable: true, sampleMinBuyerTier: 7 })).toEqual({}); // out of range: the whole object is rejected
    expect(tradeOfRow({ leadTimeDays: null, packaging: null, sampleAvailable: true, samplePricePaise: null, sampleMaxQty: 4, sampleDispatchDays: 3, sampleMinBuyerTier: 1, supplyCapacityPerMonth: null, paymentTerms: null, certifications: [] })).toEqual({ sampleAvailable: true, sampleMaxQty: 4, sampleDispatchDays: 3, sampleMinBuyerTier: 1 });
  });
  it("tradeOfRow converts paise bigint to a number", () => {
    expect(tradeOfRow({ leadTimeDays: 7, packaging: null, sampleAvailable: true, samplePricePaise: 25000n, supplyCapacityPerMonth: null, paymentTerms: null, certifications: [] })).toEqual({ leadTimeDays: 7, sampleAvailable: true, samplePricePaise: 25000 });
  });
  it("input schema validates tiers/trade shape", () => {
    const base = { categoryId: crypto.randomUUID(), title: "x", description: "", attributes: {}, pricePaise: 1, priceUnit: "pcs", moq: 1, moqUnit: "pcs", hsn: null, language: "en", imageUrls: [] };
    expect(listingInputSchema.safeParse({ ...base, priceTiers: [{ minQty: 1, pricePaise: 10 }], trade: { leadTimeDays: 3 } }).success).toBe(true);
    expect(listingInputSchema.safeParse({ ...base, priceTiers: [{ minQty: 1.5, pricePaise: 10 }] }).success).toBe(false);
    expect(listingInputSchema.safeParse({ ...base, trade: { leadTimeDays: -1 } }).success).toBe(false);
  });
});

describe("diffSnapshots with tiers/trade", () => {
  const snap = (o: Partial<VersionSnapshot> = {}): VersionSnapshot => ({ title: "A", description: "d", categoryId: "c", categoryName: "Cat", attributes: {}, pricePaise: null, priceUnit: null, moq: null, moqUnit: null, hsn: null, language: "en", imageIds: [], imageUrls: [], ...o });
  it("reports tier and trade changes, and nothing when equal / absent vs empty", () => {
    expect(diffSnapshots(snap(), snap({ priceTiers: [], trade: {} }))).toEqual([]);
    const d = diffSnapshots(snap(), snap({ priceTiers: [{ minQty: 1, pricePaise: 1 }], trade: { leadTimeDays: 5, certifications: ["BIS"] } }));
    expect(d.map((c) => c.field)).toEqual(["priceTiers", "trade.leadTimeDays", "trade.certifications"]);
  });
});
