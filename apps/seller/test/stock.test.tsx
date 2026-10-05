import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/features/listings/stock-actions", () => ({ quickStockAction: async () => null, saveVariantsAction: async () => null, updateVariantStockAction: async () => null }));
vi.mock("../src/features/listings/actions", () => ({ saveListingAction: async () => null }));
const { missingCombinations, needsLeadTime, parseVariantRows, rowsFromVariants, suggestSku } = await import("../src/features/listings/stock-form");
const { VariantsEditor } = await import("../src/features/listings/variants-editor");
const { StockToggle } = await import("../src/features/listings/stock-toggle");
const { AvailabilityFields } = await import("../src/features/listings/stock-fields");
const { AvailabilityBadge, ListingStockBadges } = await import("../src/features/listings/stock-badges");

const messages = JSON.parse(readFileSync(join(__dirname, "..", "messages", "en.stock.json"), "utf8"));
const wrap = (node: React.ReactNode) => renderToStaticMarkup(<NextIntlClientProvider locale="en" messages={messages}>{node}</NextIntlClientProvider>);

const axes = [
  { key: "size", label: "Size", options: ["S", "M", "L"] },
  { key: "colour", label: "Colour" },
];
const row = (over: Partial<Parameters<typeof parseVariantRows>[0][number]> = {}) => ({
  sku: "TS-M", axes: { size: "M", colour: "Red" }, priceRupees: "", moq: "", tiers: [], availability: "in_stock" as const, qty: "", leadTime: "", imageId: "", ...over,
});

describe("parseVariantRows", () => {
  it("converts rupees to paise once, trims, and maps blanks to null", () => {
    const { variants, errors } = parseVariantRows([row({ id: "11111111-1111-4111-8111-111111111111", priceRupees: "19.99", moq: "5", qty: "40", leadTime: "", tiers: [{ minQty: "50", price: "17.5" }, { minQty: "", price: "" }] })], axes);
    expect(errors).toEqual([]);
    expect(variants[0]).toMatchObject({ id: "11111111-1111-4111-8111-111111111111", sku: "TS-M", axisValues: { size: "M", colour: "Red" }, pricePaise: 1999, moq: 5, availableQty: 40, leadTimeDays: null, priceTiers: [{ minQty: 50, pricePaise: 1750 }], imageId: null });
  });
  it("reports the row number for a missing SKU, axis value, bad number, bad price and half-filled tier", () => {
    const { errors } = parseVariantRows([row({ sku: " ", axes: { size: "M" }, moq: "2.5", priceRupees: "-1", tiers: [{ minQty: "10", price: "" }] })], axes);
    expect(errors.map((e) => e.code).sort()).toEqual(["axis", "number", "price", "sku", "tier"]);
    expect(errors.every((e) => e.n === 1)).toBe(true);
    expect(errors.find((e) => e.code === "axis")?.axis).toBe("Colour");
  });
  it("drops the quantity of an out-of-stock variant instead of refusing it", () => {
    expect(parseVariantRows([row({ availability: "out_of_stock", qty: "9" })], axes).variants[0]!.availableQty).toBeNull();
  });
});

describe("combinations", () => {
  it("lists option combinations that are not rows yet, case-insensitively, up to the room left", () => {
    const only = [{ key: "size", label: "Size", options: ["S", "M", "L"] }];
    expect(missingCombinations(only, [{ size: "m" }], 10)).toEqual([{ size: "S" }, { size: "L" }]);
    expect(missingCombinations(only, [], 2)).toHaveLength(2);
    expect(missingCombinations(only, [], 0)).toEqual([]);
  });
  it("enumerates only axes with options (free-text axes stay empty) and nothing when no axis has options", () => {
    expect(missingCombinations(axes, [], 10)).toEqual([{ size: "S" }, { size: "M" }, { size: "L" }]);
    expect(missingCombinations([{ key: "colour", label: "Colour" }], [], 10)).toEqual([]);
  });
  it("suggests a clean SKU", () => {
    expect(suggestSku("Tee-shirt", axes, { size: "M", colour: "Sky blue" })).toBe("TEESHIRT-M-SKYBLUE");
    expect(suggestSku("", axes, {})).toBe("VAR");
  });
  it("made-to-order without a lead time needs one", () => {
    expect(needsLeadTime("made_to_order", null)).toBe(true);
    expect(needsLeadTime("made_to_order", 0)).toBe(false);
    expect(needsLeadTime("in_stock", null)).toBe(false);
  });
});

describe("rowsFromVariants", () => {
  it("round-trips through parseVariantRows", () => {
    const rows = rowsFromVariants([
      { id: "11111111-1111-4111-8111-111111111111", sku: "A", axisValues: { size: "S", colour: "Red" }, pricePaise: 1250, priceTiers: [{ minQty: 10, pricePaise: 1000 }], moq: 4, availability: "made_to_order", availableQty: null, leadTimeDays: 9, imageId: null, sortOrder: 0, stockUpdatedAt: null },
    ]);
    const { variants } = parseVariantRows(rows, axes);
    expect(variants[0]).toMatchObject({ sku: "A", pricePaise: 1250, moq: 4, leadTimeDays: 9, availability: "made_to_order", priceTiers: [{ minQty: 10, pricePaise: 1000 }] });
  });
});

describe("VariantsEditor", () => {
  const initial = [
    { id: "11111111-1111-4111-8111-111111111111", sku: "TS-M", axisValues: { size: "M", colour: "Red" }, pricePaise: null, priceTiers: [], moq: null, availability: "in_stock" as const, availableQty: 12, leadTimeDays: null, imageId: null, sortOrder: 0, stockUpdatedAt: null },
  ];
  it("renders labelled inputs per axis (select for closed lists, text otherwise), both save buttons and the review/instant hints", () => {
    const html = wrap(<VariantsEditor listingId="l1" axes={axes} initial={initial} images={[{ id: "i1", label: "Image 1" }]} skuBase="Tee" />);
    expect(html).toContain("Variant 1");
    expect(html).toContain("Variant SKU");
    expect(html).toMatch(/<select[^>]*id="v-11111111-1111-4111-8111-111111111111-ax-size"/);
    expect(html).toMatch(/<input[^>]*id="v-11111111-1111-4111-8111-111111111111-ax-colour"/);
    expect(html).toContain("Remove variant 1");
    expect(html).toContain("Generate all combinations");
    expect(html).toContain("Save variants");
    expect(html).toContain("Update stock now");
    expect(html).toContain("1 of 100 variants");
    expect(html).toContain("without review");
    expect(html).toContain("Image 1");
  });
  it("explains why variants are unavailable when the category has no axes", () => {
    const html = wrap(<VariantsEditor listingId="l1" axes={[]} initial={[]} images={[]} skuBase="x" />);
    expect(html).toContain("no variant options configured");
    expect(html).not.toContain("Save variants");
  });
});

describe("stock controls", () => {
  it("toggle: labelled select with the three states; listings with variants link to the editor instead", () => {
    const html = wrap(<StockToggle listingId="l1" title="Tee" availability="in_stock" leadTimeDays={null} variantCount={0} />);
    expect(html).toContain("Stock status of Tee");
    for (const s of ["In stock", "Made to order", "Out of stock"]) expect(html).toContain(s);
    expect(html).toContain('aria-live="polite"');
    const v = wrap(<StockToggle listingId="l1" title="Tee" availability="in_stock" leadTimeDays={null} variantCount={3} />);
    expect(v).toContain("/listings/l1/edit#variants");
    expect(v).not.toContain("<select");
  });
  it("availability fields: status + quantity, or the derived rollup when the listing has variants", () => {
    const base = { id: "l1", availability: "in_stock", ownAvailability: "in_stock", availableQty: 8 } as never;
    const plain = wrap(<AvailabilityFields listing={base} state={null} />);
    expect(plain).toContain('name="availability"');
    expect(plain).toContain('name="availableQty"');
    expect(plain).toContain('value="8"');
    const withVariants = wrap(<AvailabilityFields listing={{ ...(base as object), availability: "made_to_order", variants: [{ id: "v" }] } as never} state={null} />);
    expect(withVariants).toContain("best stock among them: Made to order");
    expect(withVariants).not.toContain('name="availability"');
  });
  it("badges show text for every state plus qty / lead time, and the variant count with the rollup", () => {
    expect(wrap(<AvailabilityBadge availability="in_stock" availableQty={1200} />)).toContain("1,200 available");
    expect(wrap(<AvailabilityBadge availability="made_to_order" leadTimeDays={14} />)).toContain("Ships in 14 days");
    expect(wrap(<AvailabilityBadge availability="out_of_stock" availableQty={5} />)).not.toContain("available");
    const html = wrap(<ListingStockBadges listing={{ availability: "in_stock", variants: [{}, {}], trade: {} } as never} />);
    expect(html).toContain("2 variants");
    expect(html).toContain("best stock among variants");
  });
});
