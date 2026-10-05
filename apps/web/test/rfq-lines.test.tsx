// Multi-line RFQ UI logic and markup (docs/design/rfq-multiline.md): BOM import mapping + sanitising, editor, line matrix.
import type { ComparisonRow, QuoteComparison } from "@cnote/enquiry";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import enBuyer from "../messages/en.buyer.json";
import enLines from "../messages/en.rfqLines.json";
import enRfq2 from "../messages/en.rfq2.json";
import hiLines from "../messages/hi.rfqLines.json";
import { MAX_BOM_LINES, applyMapping, detectMapping, linesFromForm, moveRow, normaliseUnit, rowsToLines, sanitizeCell, validateRow, type BomRow } from "@/features/enquiry/bom";

vi.mock("@/features/enquiry/actions", () => ({ awardLinesAction: async () => null, quoteDecisionAction: async () => null, shortlistQuoteAction: async () => null, postRfqAction: async () => null }));

const { LineMatrix } = await import("@/features/enquiry/line-matrix");
const { BomEditor } = await import("@/features/enquiry/bom-editor");

describe("BOM column detection and import", () => {
  it("maps common header spellings (case, units in brackets, synonyms)", () => {
    const m = detectMapping(["S.No", "Item Name", "Specification", "Qty", "UOM", "Target Price (INR per unit)", "HSN Code", "Category"]);
    expect(m).toMatchObject({ itemName: 1, spec: 2, quantity: 3, unit: 4, targetPrice: 5, hsn: 6, category: 7 });
    expect(detectMapping(["Description", "Quantity"])).toMatchObject({ itemName: 0, quantity: 1, unit: null, hsn: null });
    expect(detectMapping(["x", "y"]).itemName).toBeNull();
  });

  it("imports rows, skipping bad ones with a reason, normalising units/prices, stripping formula starts", () => {
    const mapping = detectMapping(["Item", "Qty", "Unit", "Rate", "HSN", "Category", "Notes"]);
    const cats = [{ slug: "fasteners", name: "Fasteners" }];
    const r = applyMapping(
      [
        ["Bolt M8", "1,000", "Nos", "₹12.50", "7318 1500", "Fasteners", "SS304"],
        ["=HYPERLINK(\"http://evil\")", "5", "kg", "", "", "", "=cmd|' /C calc'!A0"],
        ["", "4", "kg", "", "", "", ""],
        ["Nut", "2.5", "pcs", "", "", "", ""],
        ["Washer", "10", "", "abc", "12", "Unknown cat", ""],
        ["", "", "", "", "", "", ""],
      ],
      mapping,
      cats,
    );
    expect(r.rows.map((x) => [x.itemName, x.quantity, x.unit, x.targetPrice, x.hsn, x.categorySlug, x.spec])).toEqual([
      ["Bolt M8", "1000", "pcs", "12.50", "73181500", "fasteners", "SS304"],
      ['HYPERLINK("http://evil")', "5", "kg", "", "", "", "cmd|' /C calc'!A0"],
      ["Washer", "10", "pcs", "", "12", "", ""],
    ]);
    expect(r.skipped).toEqual([{ row: 4, reason: "noItem" }, { row: 5, reason: "badQuantity" }, { row: 6, reason: "unknownCategory" }]);
  });

  it("caps at the room left and counts the rest as clipped", () => {
    const data = Array.from({ length: 60 }, (_, i) => [`Item ${i}`, "1"]);
    const r = applyMapping(data, detectMapping(["Item", "Qty"]), []);
    expect(r.rows).toHaveLength(MAX_BOM_LINES);
    expect(r.clipped).toBe(10);
  });

  it("sanitises cells: control chars, leading formula characters, but keeps a negative-looking size", () => {
    expect(sanitizeCell("  =SUM(A1)  ")).toBe("SUM(A1)");
    expect(sanitizeCell("+@-cmd")).toBe("cmd");
    expect(sanitizeCell("-5 mm washer")).toBe("-5 mm washer");
    expect(sanitizeCell("a\u0000b\u0007c")).toBe("abc");
    expect(sanitizeCell("x".repeat(50), 10)).toHaveLength(10);
    expect(normaliseUnit("Kilograms")).toBe("kg");
    expect(normaliseUnit("")).toBe("pcs");
  });
});

describe("BOM rows", () => {
  const row = (o: Partial<BomRow> = {}): BomRow => ({ key: "k", itemName: "Bolt", spec: "", quantity: "10", unit: "pcs", targetPrice: "", hsn: "", categorySlug: "", ...o });
  it("validates rows", () => {
    expect(validateRow(row())).toEqual([]);
    expect(validateRow(row({ itemName: " ", quantity: "0", unit: "", targetPrice: "x", hsn: "12" })).map((e) => e.field)).toEqual(["itemName", "quantity", "unit", "targetPrice", "hsn"]);
    expect(validateRow(row({ quantity: "1.5" }))[0]).toMatchObject({ field: "quantity" });
  });
  it("turns rupees into integer paise", () => {
    expect(rowsToLines([row({ targetPrice: "12.5", spec: " s ", hsn: "7318" })])).toEqual([{ itemName: "Bolt", spec: "s", quantity: 10, unit: "pcs", targetPricePaise: 1250, categorySlug: null, hsn: "7318" }]);
  });
  it("moves rows by index and clamps", () => {
    expect(moveRow([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
    expect(moveRow([1, 2, 3], 0, -5)).toEqual([1, 2, 3]);
    expect(moveRow([1, 2, 3], 0, 9)).toEqual([2, 3, 1]);
    expect(moveRow([1, 2, 3], 7, 0)).toEqual([1, 2, 3]);
  });
  it("reads the lines JSON of the form, refusing junk and oversize input", () => {
    const f = new FormData();
    expect(linesFromForm(f)).toBeUndefined();
    f.set("lines", JSON.stringify([{ itemName: "a" }]));
    expect(linesFromForm(f)).toEqual([{ itemName: "a" }]);
    f.set("lines", "{nope");
    expect(() => linesFromForm(f)).toThrow(/reload/);
    f.set("lines", "x".repeat(300_001));
    expect(() => linesFromForm(f)).toThrow();
  });
});

function render(ui: React.ReactElement, locale = "en") {
  const messages = locale === "hi" ? { ...en, ...enBuyer, ...enRfq2, ...hiLines } : { ...en, ...enBuyer, ...enRfq2, ...enLines };
  return renderToStaticMarkup(<NextIntlClientProvider locale={locale} timeZone="Asia/Kolkata" messages={messages as never}>{ui}</NextIntlClientProvider>);
}

describe("BomEditor markup", () => {
  it("renders a labelled card per line with move/remove controls, a live count and the upload with a template link", () => {
    const html = render(<BomEditor categories={[{ slug: "fasteners", name: "Fasteners" }]} initialRows={[{ itemName: "Bolt", quantity: "5" }, { itemName: "Nut", quantity: "6" }]} />);
    expect(html).toContain("Line 1");
    expect(html).toContain("Line 2");
    expect(html).toContain('aria-label="Move line 2 up"');
    expect(html).toContain('aria-label="Remove line 1"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*aria-label="Move line 1 up"|aria-label="Move line 1 up"[^>]*disabled/);
    expect(html).toContain("2 of 50 lines");
    expect(html).toContain('href="/api/rfq/bom"');
    expect(html).toContain('accept=".csv,.tsv,.txt,.xlsx"');
    expect(html).toContain("&quot;itemName&quot;:&quot;Bolt&quot;");
    expect((html.match(/<fieldset/g) ?? []).length).toBe(2);
    expect(render(<BomEditor categories={[]} />, "hi")).toContain("लाइन 1");
  });
});

const qline = (enquiryLineId: string, ordinal: number, unit: number | null, total: number | null, cant = false) => ({
  id: `ql-${enquiryLineId}`, enquiryLineId, ordinal, unitPricePaise: unit, gstRatePct: 18, leadTimeDays: 7, cantSupply: cant, notes: null, quantity: 10,
  lineSubtotalPaise: total, lineGstPaise: 0, lineTotalPaise: total,
});
const mrow = (id: string, lines: ReturnType<typeof qline>[]): ComparisonRow => ({
  matchId: id, conversationId: `c-${id}`, sellerBusinessId: `s-${id}`, sellerName: `Supplier ${id}`, verificationTier: 1, badgeActive: true, trustScore: 60, rank: 1, of: 3,
  totalPaise: 5000, quantityBasis: "lines", coverage: { quoted: lines.filter((l) => !l.cantSupply).length, of: 3 }, quantity: 10, decision: null, earlierQuotes: 0,
  quote: {
    id: `q-${id}`, pricePaise: 100, quantity: 10, unit: "pcs", leadTimeDays: 7, notes: null, validUntil: null, createdAt: "2026-10-01T00:00:00.000Z", moq: null, moqUnit: null,
    deliveryTerms: null, deliveryNote: null, deliveryChargePaise: null, paymentTerms: null, paymentNote: null, gstIncluded: null, attachments: [], shortlisted: false,
    lineTotals: { subtotalPaise: 5000, gstPaise: 0, totalPaise: 5000, quotedLineCount: lines.length }, lines,
  },
});
const lineView = (id: string, ordinal: number, itemName: string) => ({ id, ordinal, itemName, spec: null, quantity: 10, unit: "pcs", targetPricePaise: null, category: null, hsn: null });
const cmp = (): QuoteComparison => ({
  enquiryId: "e1", quantity: 10, quantityUnit: "pcs", sentTo: 3, quotesFrom: 2, expiresAt: null,
  rows: [
    mrow("a", [qline("L1", 1, 100, 1000), qline("L2", 2, 300, 3000), qline("L3", 3, null, null, true)]),
    mrow("b", [qline("L1", 1, 120, 1200), qline("L2", 2, 250, 2500)]),
  ],
  lines: [lineView("L1", 1, "Bolt"), lineView("L2", 2, "Nut"), lineView("L3", 3, "Washer")],
  lowestByLine: { L1: ["q-a"], L2: ["q-b"] },
  awards: [{ enquiryLineId: "L1", quoteId: "q-a", sellerBusinessId: "s-a", orderId: "o1" }],
});

describe("LineMatrix markup", () => {
  it("is a table with one row per line and a column per supplier; the lowest is a word, not only colour", () => {
    const html = render(<LineMatrix comparison={cmp()} />);
    expect((html.match(/data-testid="matrix-row"/g) ?? []).length).toBe(3);
    expect(html).toContain('scope="col"');
    expect(html).toContain("Supplier a");
    expect(html).toContain("Supplier b");
    expect(html.match(/Lowest/g)!.length).toBeGreaterThanOrEqual(2); // L1 -> a, L2 -> b (desktop + mobile)
    expect(html).toContain("Can&#x27;t supply");
    expect(html).toContain("Skipped"); // supplier b skipped line 3
    expect(html).toContain("2 of 3 lines quoted");
    expect(html).toContain("Awarded to Supplier a"); // L1 already awarded
    expect(html).toContain("Award line 2 (Nut) to Supplier b");
    expect(html).toContain("No lines selected yet.");
    expect(html).toContain("<fieldset"); // mobile cards group radios per line
  });
  it("disables radios for awarded lines, unpriced cells and suppliers that already hold an order", () => {
    const html = render(<LineMatrix comparison={cmp()} />);
    const radios = [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((m) => m[0]);
    expect(radios.length).toBe(2 * 3 * 2); // desktop + mobile, 3 lines x 2 suppliers
    // supplier a holds an order (L1 awarded), so all its radios are disabled; supplier b: L1 awarded, L3 skipped
    const enabled = radios.filter((r) => !/disabled/.test(r));
    expect(enabled.length).toBe(2); // L2 for supplier b, desktop + mobile
  });
  it("renders in Hindi", () => {
    expect(render(<LineMatrix comparison={cmp()} />, "hi")).toContain("लाइन-दर-लाइन तुलना");
  });
});
