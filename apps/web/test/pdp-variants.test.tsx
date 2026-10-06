import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { withRfqPrefill } from "@/features/pdp/prefill";
import {
  axisValues, bestOf, findVariant, lowestPrice, optionAvailability, picksOf, resolveChoice, variantBySku, variantName, variantTerms, type Availability, type PdpAxis, type PdpVariant, type Picks,
} from "@/features/pdp/variants";

const axes: PdpAxis[] = [{ key: "size", label: "Size" }, { key: "colour", label: "Colour" }];
const mk = (sku: string, size: string, colour: string, extra: Partial<PdpVariant> = {}): PdpVariant => ({
  id: sku, sku, axisValues: { size, colour }, pricePaise: null, priceTiers: [], moq: null, availability: "in_stock", availableQty: null, leadTimeDays: null, imageId: null, sortOrder: 0, ...extra,
});
const variants: PdpVariant[] = [
  mk("M-RED", "M", "Red", { pricePaise: 45_000, priceTiers: [{ minQty: 50, pricePaise: 42_000 }], moq: 10, sortOrder: 0 }),
  mk("M-BLUE", "M", "Blue", { sortOrder: 1 }),
  mk("L-RED", "L", "Red", { availability: "made_to_order", leadTimeDays: 14, sortOrder: 2 }),
  mk("L-BLUE", "L", "Blue", { availability: "out_of_stock", sortOrder: 3 }),
  mk("XL-GREEN", "XL", "Green", { availability: "in_stock", sortOrder: 4 }),
];
const base = { pricePaise: 50_000, priceTiers: [{ minQty: 100, pricePaise: 48_000 }], moq: 20, leadTimeDays: 7 };

describe("variant selection logic", () => {
  it("rolls availability up and finds the variant for a complete choice only", () => {
    expect(bestOf(["out_of_stock", "made_to_order"])).toBe("made_to_order");
    expect(bestOf([])).toBe("out_of_stock");
    expect(findVariant(variants, axes, { size: "M", colour: "Blue" })?.sku).toBe("M-BLUE");
    expect(findVariant(variants, axes, { size: "M" })).toBeUndefined();
    expect(findVariant(variants, axes, { size: "XL", colour: "Red" })).toBeUndefined(); // combination not offered
    expect(variantName(variants[0]!, axes)).toBe("M / Red");
    expect(axisValues(variants, "size")).toEqual(["M", "L", "XL"]);
  });

  it("option status reflects the OTHER current choices and says when a combination does not exist", () => {
    const picks: Picks = { size: "L" };
    expect(optionAvailability(variants, picks, "colour", "Red")).toBe("made_to_order");
    expect(optionAvailability(variants, picks, "colour", "Blue")).toBe("out_of_stock");
    expect(optionAvailability(variants, picks, "colour", "Green")).toBeNull();
    expect(optionAvailability(variants, {}, "size", "M")).toBe("in_stock");
  });

  it("choosing keeps a valid combination, otherwise adopts the first variant that offers the value", () => {
    expect(resolveChoice(variants, { size: "M", colour: "Red" }, "colour", "Blue")).toEqual({ size: "M", colour: "Blue" });
    expect(resolveChoice(variants, { size: "M", colour: "Red" }, "size", "XL")).toEqual({ size: "XL", colour: "Green" });
    expect(resolveChoice(variants, {}, "size", "L")).toEqual({ size: "L" });
    expect(resolveChoice(variants, { size: "M" }, "colour", "Nope")).toEqual({ size: "M", colour: "Nope" });
  });

  it("variantBySku ignores unknown skus; picksOf copies the axis values", () => {
    expect(variantBySku(variants, "L-RED")?.sku).toBe("L-RED");
    expect(variantBySku(variants, "NOPE")).toBeUndefined();
    expect(variantBySku(variants, null)).toBeUndefined();
    expect(picksOf(variants[2])).toEqual({ size: "L", colour: "Red" });
    expect(picksOf(undefined)).toEqual({});
  });

  it("effective terms: the variant overrides what it sets, the listing supplies the rest", () => {
    expect(variantTerms(base, null)).toEqual(base);
    expect(variantTerms(base, variants[1])).toEqual(base); // M-BLUE overrides nothing
    expect(variantTerms(base, variants[0])).toEqual({ pricePaise: 45_000, priceTiers: [{ minQty: 50, pricePaise: 42_000 }], moq: 10, leadTimeDays: 7 });
    expect(variantTerms(base, variants[2]).leadTimeDays).toBe(14);
    expect(variantTerms(base, mk("FLAT", "S", "x", { pricePaise: 70_000 })).priceTiers).toEqual([]); // a flat price does not inherit the listing's slabs
  });

  it("lowest price looks at variant prices and slabs", () => {
    expect(lowestPrice(base, variants)).toBe(42_000);
    expect(lowestPrice(base, [])).toBe(48_000);
    expect(lowestPrice({ pricePaise: null, priceTiers: [], moq: null, leadTimeDays: null }, [])).toBeNull();
  });
});

describe("RFQ prefill carries the variant", () => {
  it("adds variant + label next to qty/unit/price, and nothing without a variant", () => {
    const href = withRfqPrefill("/rfq/new?listing=abc", { quantity: 50, unit: "piece", pricePaise: 42_000, variantSku: "M-RED", variantLabel: "M / Red" });
    const q = new URL(href, "https://x").searchParams;
    expect([q.get("qty"), q.get("unit"), q.get("price"), q.get("variant"), q.get("vlabel")]).toEqual(["50", "piece", "42000", "M-RED", "M / Red"]);
    expect(new URL(withRfqPrefill("/rfq/new?listing=abc", { quantity: 5 }), "https://x").searchParams.has("variant")).toBe(false);
    expect(withRfqPrefill("/other", { quantity: 5, variantSku: "A" })).toBe("/other");
  });
});

// ---- rendering: the context is replaced by a fixed selection so the markup of each state can be asserted

const ctx = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("@/features/pdp/variant-context", () => ({ useVariantSelection: () => ctx.state, VariantProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/features/leadgen/unlock-buttons", () => ({
  UnlockButton: ({ label, prefill }: { label: string; prefill?: unknown }) => <button type="button" data-prefill={JSON.stringify(prefill ?? null)}>{label}</button>,
}));
const { VariantSelector } = await import("@/features/pdp/variant-selector");
const { PurchasePanel } = await import("@/features/pdp/purchase-panel");
const { StockStatus } = await import("@/features/pdp/stock-status");
const { AvailabilityBadge } = await import("@/features/pdp/availability-badge");

const en = JSON.parse(readFileSync(join(__dirname, "..", "messages", "en.pdp.json"), "utf8"));
const wrap = (node: React.ReactNode) => renderToStaticMarkup(<NextIntlClientProvider locale="en" messages={en}>{node}</NextIntlClientProvider>);
const setSelection = (picks: Picks, stock: Availability = "in_stock", stockUpdatedAt: string | null = null) => {
  ctx.state = { axes, variants, stock: { availability: stock, availableQty: null, stockUpdatedAt }, picks, selected: findVariant(variants, axes, picks) ?? null, choose: () => undefined, clear: () => undefined };
};

describe("VariantSelector", () => {
  it("is one fieldset + legend per axis with real radios, option stock in text, and an empty polite live region before a choice", () => {
    setSelection({});
    const html = wrap(<VariantSelector base={base} unit="piece" />);
    expect(html.match(/<fieldset/g)).toHaveLength(2);
    expect(html).toContain("<legend");
    expect(html.match(/type="radio"/g)).toHaveLength(6); // size: M, L, XL ; colour: Red, Blue, Green
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toMatch(/Choose Size, Colour to see the exact price/);
    expect(html).not.toContain("Reset choices");
  });

  it("marks options by text: out of stock / made to order / changes other choices, relative to the other choices", () => {
    setSelection({ size: "L" });
    const html = wrap(<VariantSelector base={base} unit="piece" />);
    expect(html).toContain("Out of stock"); // L / Blue
    expect(html).toContain("Made to order"); // L / Red
    expect(html).toContain("also changes other choices"); // L / Green does not exist
  });

  it("a chosen variant is checked and announced with its name, availability and price", () => {
    setSelection({ size: "M", colour: "Red" });
    const html = wrap(<VariantSelector base={base} unit="piece" />);
    expect(html.match(/checked=""/g)).toHaveLength(2);
    expect(html).toContain("Selected M / Red. In stock. ₹450 / piece.");
    expect(html).toContain("SKU M-RED");
    expect(html).toContain("Reset choices");
  });

  it("announces the lead time of a made-to-order choice", () => {
    setSelection({ size: "L", colour: "Red" });
    expect(wrap(<VariantSelector base={base} unit="piece" />)).toContain("Made to order, 14 days lead time");
  });

  it("renders nothing for a listing without variants", () => {
    ctx.state = { axes: [], variants: [], stock: { availability: "in_stock", availableQty: null, stockUpdatedAt: null }, picks: {}, selected: null, choose: () => undefined, clear: () => undefined };
    expect(wrap(<VariantSelector base={base} unit="piece" />)).toBe("");
  });
});

describe("PurchasePanel uses the chosen variant", () => {
  const props = {
    listingId: "l1", listingTitle: "Tee", unit: "piece", basePaise: base.pricePaise, tiers: base.priceTiers, moq: base.moq, moqText: "20 piece", moqUnit: "piece", leadTimeDays: 7,
    labels: { priceOnRequest: "Price on request", minOrder: "Minimum order: 20 piece", indicative: "Indicative price", getBestPrice: "Get best price", requestQuote: "Request quote" },
  };

  it("without a choice: the listing's terms, a 'prices vary' note, and no variant in the prefill", () => {
    setSelection({});
    const html = wrap(<PurchasePanel {...props} />);
    expect(html).toContain("₹500");
    expect(html).toContain("Minimum order: 20 piece");
    expect(html).toContain("Price and minimum order depend on the option you choose.");
    expect(html).toContain("&quot;variantSku&quot;:null");
  });

  it("with a choice: its price, slabs, MOQ and estimate replace the listing's, and the prefill carries sku + label", () => {
    setSelection({ size: "M", colour: "Red" });
    const html = wrap(<PurchasePanel {...props} />);
    expect(html).toContain("₹450"); // the variant's own base price (45,000 paise)
    expect(html).toContain("Minimum order: 10 piece");
    expect(html).toContain('value="10"'); // quantity starts at the variant's MOQ
    expect(html).toContain("Estimated total");
    expect(html).toContain("₹4,500"); // 10 x 450
    expect(html).toContain("&quot;variantSku&quot;:&quot;M-RED&quot;");
    expect(html).toContain("&quot;variantLabel&quot;:&quot;M / Red&quot;");
    expect(html).not.toContain("depend on the option you choose");
  });
});

describe("availability display", () => {
  it("badge: text + icon per state, never colour alone", () => {
    for (const [a, label] of [["in_stock", "In stock"], ["made_to_order", "Made to order"], ["out_of_stock", "Out of stock"]] as const) {
      const html = wrap(<AvailabilityBadge availability={a} label={label} />);
      expect(html).toContain(label);
      expect(html).toContain("<svg");
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain(`data-availability="${a}"`);
    }
  });

  it("StockStatus: listing state before a choice, the variant's after; quantity, updated date, lead time and the out-of-stock note", () => {
    setSelection({}, "made_to_order", "2026-10-01T00:00:00Z");
    let html = wrap(<StockStatus listingLeadTimeDays={9} />);
    expect(html).toContain("Made to order, 9 days lead time");
    expect(html).toContain("Stock updated");
    setSelection({ size: "L", colour: "Blue" }, "in_stock");
    html = wrap(<StockStatus listingLeadTimeDays={null} />);
    expect(html).toContain("Out of stock");
    expect(html).toContain("You can still request a quote");
    setSelection({ size: "M", colour: "Red" });
    ctx.state = { ...(ctx.state as object), selected: { ...variants[0]!, availableQty: 120 } };
    expect(wrap(<StockStatus listingLeadTimeDays={null} />)).toContain("120 available");
  });
});

describe("messages", () => {
  it("every placeholder used by the new strings exists in en and hi", () => {
    const hi = JSON.parse(readFileSync(join(__dirname, "..", "messages", "hi.pdp.json"), "utf8"));
    for (const k of ["availability", "variants"] as const) expect(Object.keys(hi.pdp[k]).sort()).toEqual(Object.keys(en.pdp[k]).sort());
  });
});
