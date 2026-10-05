import { describe, expect, it } from "vitest";
import { bestAvailability, effectiveAvailability, isBackInStock, validateStock } from "../src/availability";
import { buildLiveStock, refreshLiveStock, type WorkingStock } from "../src/live-stock";
import { categoryAxes, effectiveVariantTerms, normaliseVariants, parseVariants, splitVariantKey, variantValueKeys, type VariantInput, type VariantView } from "../src/variants";
import { diffSnapshots, type VersionSnapshot } from "../src/versions";
import { canonicalText } from "../src/validate";

const axes = [
  { key: "size", label: "Size", options: ["S", "M", "L"] },
  { key: "colour", label: "Colour" },
];
const ctx = { listingMoq: 10, listingLeadTimeDays: null };
const v = (sku: string, size: string, colour: string, extra: Partial<VariantInput> = {}): VariantInput => ({ sku, axisValues: { size, colour }, ...extra });

describe("availability", () => {
  it("ranks in_stock > made_to_order > out_of_stock and rolls variants up", () => {
    expect(bestAvailability([])).toBe("out_of_stock");
    expect(bestAvailability(["out_of_stock", "made_to_order"])).toBe("made_to_order");
    expect(bestAvailability(["made_to_order", "in_stock", "out_of_stock"])).toBe("in_stock");
    expect(effectiveAvailability("out_of_stock", [])).toBe("out_of_stock"); // no variants: the listing's own flag
    expect(effectiveAvailability("in_stock", [{ availability: "out_of_stock" }])).toBe("out_of_stock"); // variants win over the own flag
    expect(effectiveAvailability("out_of_stock", [{ availability: "out_of_stock" }, { availability: "in_stock" }])).toBe("in_stock");
  });

  it("back in stock is only out_of_stock -> orderable", () => {
    expect(isBackInStock("out_of_stock", "in_stock")).toBe(true);
    expect(isBackInStock("out_of_stock", "made_to_order")).toBe(true);
    expect(isBackInStock("in_stock", "out_of_stock")).toBe(false);
    expect(isBackInStock("in_stock", "made_to_order")).toBe(false);
    expect(isBackInStock("made_to_order", "in_stock")).toBe(false);
    expect(isBackInStock("out_of_stock", "out_of_stock")).toBe(false);
  });

  it("validates the stock state", () => {
    expect(validateStock({ availability: "in_stock", availableQty: null, leadTimeDays: null })).toEqual([]);
    expect(validateStock({ availability: "made_to_order", availableQty: null, leadTimeDays: null })[0]).toMatch(/lead time/);
    expect(validateStock({ availability: "made_to_order", availableQty: null, leadTimeDays: 0 })).toEqual([]);
    expect(validateStock({ availability: "out_of_stock", availableQty: 5, leadTimeDays: null })[0]).toMatch(/out-of-stock/);
    expect(validateStock({ availability: "in_stock", availableQty: 0, leadTimeDays: null })[0]).toMatch(/out of stock/);
    expect(validateStock({ availability: "in_stock", availableQty: -1, leadTimeDays: null }, "Variant X")[0]).toMatch(/^Variant X:/);
  });
});

describe("categoryAxes", () => {
  it("reads axes from the category schema, drops malformed and duplicate ones, keeps at most 4", () => {
    expect(categoryAxes(undefined)).toEqual([]);
    expect(categoryAxes({ variantAxes: "nope" })).toEqual([]);
    const out = categoryAxes({
      variantAxes: [{ key: "size", label: "Size", options: ["S"] }, { key: "Bad Key", label: "x" }, { key: "size", label: "dup" }, { key: "a1", label: "A" }, { key: "a2", label: "B" }, { key: "a3", label: "C" }, { key: "a4", label: "D" }],
    });
    expect(out.map((a) => a.key)).toEqual(["size", "a1", "a2", "a3"]);
    expect(out[0]).toEqual({ key: "size", label: "Size", options: ["S"] });
  });
});

describe("normaliseVariants", () => {
  it("accepts a valid set and snaps option values to their canonical case", () => {
    const r = normaliseVariants(axes, [v("A-S-RED", "s", "Red"), v("A-M-RED", "M", "Red", { priceTiers: [{ minQty: 10, pricePaise: 900 }], moq: 10 })], ctx);
    expect(r.errors).toEqual([]);
    expect(r.variants[0]!.axisValues).toEqual({ size: "S", colour: "Red" });
  });

  it("refuses variants in a category without axes", () => {
    expect(normaliseVariants([], [v("X", "S", "Red")], ctx).errors[0]).toMatch(/no variant axes/);
    expect(normaliseVariants([], [], ctx)).toEqual({ variants: [], errors: [] });
  });

  it("requires every axis, rejects unknown axes and values outside a closed option list", () => {
    const e = normaliseVariants(axes, [{ sku: "A", axisValues: { size: "S" } }, { sku: "B", axisValues: { size: "XXL", colour: "Red" } }, { sku: "C", axisValues: { size: "S", colour: "Red", grade: "A" } }], ctx).errors;
    expect(e.join("|")).toMatch(/Colour is required/);
    expect(e.join("|")).toMatch(/Size must be one of: S, M, L/);
    expect(e.join("|")).toMatch(/"grade" is not a variant axis/);
  });

  it("rejects duplicate SKUs and duplicate combinations (case-insensitively)", () => {
    const e = normaliseVariants(axes, [v("A", "S", "Red"), v("a", "M", "Red"), v("B", "s", "red")], ctx).errors;
    expect(e.join("|")).toMatch(/SKU is used twice/);
    expect(e.join("|")).toMatch(/already defined/);
  });

  it("checks tiers against the variant MOQ, else the listing's, and made-to-order lead times", () => {
    expect(normaliseVariants(axes, [v("A", "S", "Red", { priceTiers: [{ minQty: 5, pricePaise: 100 }] })], ctx).errors[0]).toMatch(/at or above the minimum order \(10\)/);
    expect(normaliseVariants(axes, [v("A", "S", "Red", { moq: 5, priceTiers: [{ minQty: 5, pricePaise: 100 }] })], ctx).errors).toEqual([]);
    expect(normaliseVariants(axes, [v("A", "S", "Red", { availability: "made_to_order" })], ctx).errors[0]).toMatch(/lead time/);
    expect(normaliseVariants(axes, [v("A", "S", "Red", { availability: "made_to_order" })], { ...ctx, listingLeadTimeDays: 14 }).errors).toEqual([]);
    expect(normaliseVariants(axes, [v("A", "S", "Red", { availability: "made_to_order", leadTimeDays: 3 })], ctx).errors).toEqual([]);
  });

  it("caps the set at 100 variants", () => {
    const many = Array.from({ length: 101 }, (_, i) => v(`S${i}`, "S", `c${i}`));
    expect(normaliseVariants(axes, many, ctx).errors.join("|")).toMatch(/At most 100/);
  });
});

describe("effectiveVariantTerms", () => {
  const listing = { pricePaise: 1000, priceTiers: [{ minQty: 10, pricePaise: 1000 }, { minQty: 100, pricePaise: 800 }], moq: 10, trade: { leadTimeDays: 7 } };
  const base: VariantView = { id: "1", sku: "A", axisValues: {}, pricePaise: null, priceTiers: [], moq: null, availability: "in_stock", availableQty: null, leadTimeDays: null, imageId: null, sortOrder: 0 };
  it("falls back to the listing for everything the variant does not override", () => {
    expect(effectiveVariantTerms(listing, null)).toEqual({ pricePaise: 1000, priceTiers: listing.priceTiers, moq: 10, leadTimeDays: 7 });
    expect(effectiveVariantTerms(listing, base)).toEqual({ pricePaise: 1000, priceTiers: listing.priceTiers, moq: 10, leadTimeDays: 7 });
  });
  it("a variant price without tiers is a flat price; own tiers/moq/lead time win", () => {
    expect(effectiveVariantTerms(listing, { ...base, pricePaise: 1500 })).toMatchObject({ pricePaise: 1500, priceTiers: [] });
    const own = [{ minQty: 50, pricePaise: 700 }];
    expect(effectiveVariantTerms(listing, { ...base, priceTiers: own, moq: 50, leadTimeDays: 2 })).toEqual({ pricePaise: 1000, priceTiers: own, moq: 50, leadTimeDays: 2 });
  });
});

describe("variant keys + parsing", () => {
  it("builds lower-cased axis:value keys and splits them back", () => {
    expect(variantValueKeys([{ axisValues: { size: "M", colour: "Red" } }, { axisValues: { size: "L", colour: "Red" } }])).toEqual(["colour:red", "size:l", "size:m"]);
    expect(splitVariantKey("size:xl")).toEqual({ axis: "size", value: "xl" });
    expect(splitVariantKey("nocolon")).toBeNull();
    expect(splitVariantKey(":x")).toBeNull();
  });
  it("drops malformed stored rows and defaults missing stock", () => {
    const out = parseVariants([{ id: "1", sku: "A", axisValues: { size: "S" } }, { nope: true }, "x"]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ availability: "in_stock", priceTiers: [], pricePaise: null, imageId: null });
  });
});

describe("live stock projection", () => {
  const snapVariants: VariantView[] = [
    { id: "v1", sku: "A", axisValues: { size: "S" }, pricePaise: null, priceTiers: [], moq: null, availability: "in_stock", availableQty: 10, leadTimeDays: null, imageId: "img1", sortOrder: 0 },
    { id: "v2", sku: "B", axisValues: { size: "M" }, pricePaise: null, priceTiers: [], moq: null, availability: "in_stock", availableQty: null, leadTimeDays: null, imageId: "gone", sortOrder: 1 },
  ];
  const t = new Date("2026-10-01T00:00:00Z");
  const working = (over: Partial<WorkingStock> = {}): WorkingStock => ({
    availability: "in_stock", availableQty: null, stockUpdatedAt: null,
    variants: [{ id: "v1", availability: "out_of_stock", availableQty: null, leadTimeDays: null, stockUpdatedAt: t }, { id: "v2", availability: "made_to_order", availableQty: null, leadTimeDays: 9, stockUpdatedAt: null }], ...over,
  });

  it("overlays the CURRENT stock on the snapshot structure and limits variant images to public ones", () => {
    const s = buildLiveStock({ availability: "in_stock", variantAxes: [{ key: "size", label: "Size" }], variants: snapVariants }, working(), new Set(["img1"]));
    expect(s.variants.map((x) => [x.id, x.availability, x.leadTimeDays, x.imageId])).toEqual([["v1", "out_of_stock", null, "img1"], ["v2", "made_to_order", 9, null]]);
    expect(s.availability).toBe("made_to_order");
    expect(s.stockUpdatedAt).toEqual(t);
    expect(s.variantValues).toEqual(["size:m", "size:s"]);
  });

  it("keeps the snapshot's stock for a variant that has no working row any more", () => {
    const s = buildLiveStock({ variants: snapVariants }, working({ variants: [] }), new Set());
    expect(s.variants.map((x) => x.availability)).toEqual(["in_stock", "in_stock"]);
  });

  it("without variants the listing's own stock is the effective one", () => {
    const s = buildLiveStock({ availability: "in_stock" }, working({ availability: "out_of_stock", availableQty: 0, variants: [] }), new Set());
    expect(s).toMatchObject({ availability: "out_of_stock", availableQty: 0, variants: [], variantAxes: [], variantValues: [] });
  });

  it("refreshLiveStock changes stock only: never adds or removes a variant", () => {
    const live = { variants: snapVariants, variantAxes: [] };
    const r = refreshLiveStock(live, working({ variants: [{ id: "v1", availability: "out_of_stock", availableQty: null, leadTimeDays: null, stockUpdatedAt: null }, { id: "new", availability: "in_stock", availableQty: null, leadTimeDays: null, stockUpdatedAt: null }] }));
    expect(r.variants.map((x) => [x.id, x.availability])).toEqual([["v1", "out_of_stock"], ["v2", "in_stock"]]);
    expect(r.availability).toBe("in_stock"); // v2 still in stock; the unpublished variant does not count
  });
});

describe("moderation + diff cover variants", () => {
  const snap = (variants: VariantView[]): VersionSnapshot => ({
    title: "T", description: "d", categoryId: "c", categoryName: "Cat", attributes: {}, pricePaise: 100, priceUnit: null, moq: 1, moqUnit: null, hsn: null, language: "en",
    variantAxes: [{ key: "size", label: "Size" }], variants, imageIds: [], imageUrls: [],
  });
  const base: VariantView = { id: "1", sku: "A", axisValues: { size: "S" }, pricePaise: null, priceTiers: [], moq: null, availability: "in_stock", availableQty: null, leadTimeDays: null, imageId: null, sortOrder: 0 };

  it("variant SKUs and axis values reach the moderation / embedding text", () => {
    const text = canonicalText({ title: "T", description: "d", attributes: {}, variants: [{ sku: "GUN-1", axisValues: { size: "Big" } }] }, "Cat");
    expect(text).toContain("GUN-1 Big");
    expect(canonicalText({ title: "T", description: "d", attributes: {} }, "Cat")).not.toContain("Variants");
  });

  it("diffs added, removed and changed variants, but not stock-only edits", () => {
    const a = snap([base, { ...base, id: "2", sku: "B", axisValues: { size: "M" } }]);
    const stockOnly = snap([{ ...base, availability: "out_of_stock", availableQty: 0, leadTimeDays: 4 }, { ...base, id: "2", sku: "B", axisValues: { size: "M" } }]);
    expect(diffSnapshots(a, stockOnly)).toEqual([]);
    const changed = snap([{ ...base, pricePaise: 500 }, { ...base, id: "3", sku: "C", axisValues: { size: "L" } }]);
    const d = diffSnapshots(a, changed);
    expect(d.map((x) => [x.field, x.label])).toEqual([["variants.A", "Variant A"], ["variants.C", "Variant added"], ["variants.B", "Variant removed"]]);
    expect(d[0]!.after).toContain("price 500 paise");
  });
});
