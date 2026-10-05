import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/features/listings/actions", () => ({ saveListingAction: async () => null }));
const { parseTierRows, parseTradeFields } = await import("../src/features/listings/trade-form");
const { TierFields, TradeFields } = await import("../src/features/listings/tier-fields");

const read = (f: string) => JSON.parse(readFileSync(join(__dirname, "..", "messages", f), "utf8"));
const messages = { ...read("en.listings.json"), ...read("en.samples.json") };
const wrap = (node: React.ReactNode) => renderToStaticMarkup(<NextIntlClientProvider locale="en" messages={messages}>{node}</NextIntlClientProvider>);

describe("parseTierRows", () => {
  it("converts rupees to integer paise once and skips fully blank rows", () => {
    expect(parseTierRows(["10", "", "100"], ["12.5", "", "9.99"])).toEqual({ tiers: [{ minQty: 10, pricePaise: 1250 }, { minQty: 100, pricePaise: 999 }], badRows: [] });
  });
  it("floating point rupees do not drift (19.99 -> 1999, 1.15 -> 115)", () => {
    expect(parseTierRows(["1", "2"], ["19.99", "1.15"]).tiers.map((t) => t.pricePaise)).toEqual([1999, 115]);
  });
  it("reports half-filled, fractional, zero-qty and negative rows (1-based)", () => {
    expect(parseTierRows(["10", "", "2.5", "0", "5"], ["", "7", "3", "3", "-1"]).badRows).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("parseTradeFields", () => {
  const base = { leadTimeDays: "", packaging: "", sampleAvailable: false, samplePriceRupees: "", supplyCapacityPerMonth: "", paymentTerms: "", certifications: "" };
  it("is empty by default", () => {
    expect(parseTradeFields(base)).toEqual({ trade: { leadTimeDays: null, packaging: null, sampleAvailable: false, samplePricePaise: null, sampleMaxQty: null, sampleDispatchDays: null, sampleMinBuyerTier: null, supplyCapacityPerMonth: null, paymentTerms: null, certifications: [] }, invalid: false });
  });
  it("parses numbers, sample price (only when a sample is offered) and certifications", () => {
    const r = parseTradeFields({ ...base, leadTimeDays: "7", supplyCapacityPerMonth: "5000", sampleAvailable: true, samplePriceRupees: "150", certifications: "ISO 9001, BIS\nCE", packaging: " Carton of 50 " });
    expect(r.invalid).toBe(false);
    expect(r.trade).toMatchObject({ leadTimeDays: 7, supplyCapacityPerMonth: 5000, sampleAvailable: true, samplePricePaise: 15000, certifications: ["ISO 9001", "BIS", "CE"], packaging: "Carton of 50" });
    expect(parseTradeFields({ ...base, sampleAvailable: false, samplePriceRupees: "150" }).trade.samplePricePaise).toBeNull();
  });
  it("parses the sample workflow settings only when a sample is offered, and flags bad values", () => {
    const on = { ...base, sampleAvailable: true, sampleMaxQty: "10", sampleDispatchDays: "3", sampleMinBuyerTier: "2" };
    expect(parseTradeFields(on)).toMatchObject({ invalid: false, trade: { sampleMaxQty: 10, sampleDispatchDays: 3, sampleMinBuyerTier: 2 } });
    expect(parseTradeFields({ ...on, sampleAvailable: false }).trade).toMatchObject({ sampleMaxQty: null, sampleDispatchDays: null, sampleMinBuyerTier: null });
    expect(parseTradeFields({ ...on, sampleMinBuyerTier: "5" }).invalid).toBe(true);
    expect(parseTradeFields({ ...on, sampleMaxQty: "0" }).invalid).toBe(true);
    expect(parseTradeFields({ ...on, sampleDispatchDays: "x" }).invalid).toBe(true);
  });
  it("flags non-whole or negative numbers", () => {
    expect(parseTradeFields({ ...base, leadTimeDays: "2.5" }).invalid).toBe(true);
    expect(parseTradeFields({ ...base, supplyCapacityPerMonth: "-3" }).invalid).toBe(true);
    expect(parseTradeFields({ ...base, sampleAvailable: true, samplePriceRupees: "abc" }).invalid).toBe(true);
  });
});

describe("tier + trade form fields", () => {
  it("renders existing slabs as rupee values with labelled inputs and a remove button each", () => {
    const html = wrap(<TierFields tiers={[{ minQty: 10, pricePaise: 1250 }, { minQty: 100, pricePaise: 999 }]} state={null} />);
    expect(html.match(/name="tierMinQty"/g)).toHaveLength(2);
    expect(html).toContain('value="12.5"');
    expect(html).toContain('value="9.99"');
    expect(html).toContain('aria-label="Remove tier 2"');
    expect(html).toContain("Add tier");
  });
  it("renders trade fields prefilled, with the sample price only when a sample is offered", () => {
    const on = wrap(<TradeFields trade={{ leadTimeDays: 7, sampleAvailable: true, samplePricePaise: 15000, certifications: ["ISO 9001", "BIS"] }} state={null} />);
    expect(on).toContain('value="7"');
    expect(on).toContain('name="samplePriceRupees"');
    expect(on).toContain('value="150"');
    expect(on).toContain('value="ISO 9001, BIS"');
    expect(on).toContain('name="sampleMaxQty"');
    expect(on).toContain('name="sampleMinBuyerTier"');
    expect(wrap(<TradeFields trade={{}} state={null} />)).not.toContain("samplePriceRupees");
    expect(wrap(<TradeFields trade={{}} state={null} />)).not.toContain("sampleMaxQty");
  });
});
