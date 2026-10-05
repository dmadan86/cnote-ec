// Pure maths of multi-line RFQs: line schema, GST, quote line preparation, lowest-per-line. docs/design/rfq-multiline.md
import { describe, expect, it } from "vitest";
import { MAX_ENQUIRY_LINES, deriveTitle, divRound, enquiryLinesSchema, linesDigest, lineAmounts, lowestPerLine, prepareQuoteLines, type QuoteLineView } from "../src";

const L = (n: number) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, ordinal: n, quantity: 10 * n, unit: "pcs" });
const lines = [L(1), L(2), L(3)];

describe("enquiry line schema", () => {
  it("accepts 1..50 lines and normalises optional fields", () => {
    const ok = enquiryLinesSchema.parse([{ itemName: " M8 bolt ", quantity: 100, unit: "pcs", spec: "", hsn: "73181500" }]);
    expect(ok[0]).toMatchObject({ itemName: "M8 bolt", spec: null, hsn: "73181500", targetPricePaise: null, categorySlug: null });
    expect(() => enquiryLinesSchema.parse([])).toThrow();
    const many = Array.from({ length: MAX_ENQUIRY_LINES }, (_, i) => ({ itemName: `i${i}`, quantity: 1, unit: "pcs" }));
    expect(enquiryLinesSchema.parse(many)).toHaveLength(50);
    expect(() => enquiryLinesSchema.parse([...many, many[0]])).toThrow(/up to 50/);
  });
  it("rejects bad quantity, unit and HSN", () => {
    expect(() => enquiryLinesSchema.parse([{ itemName: "x", quantity: 0, unit: "pcs" }])).toThrow();
    expect(() => enquiryLinesSchema.parse([{ itemName: "x", quantity: 1.5, unit: "pcs" }])).toThrow();
    expect(() => enquiryLinesSchema.parse([{ itemName: "x", quantity: 1, unit: "" }])).toThrow();
    expect(() => enquiryLinesSchema.parse([{ itemName: "x", quantity: 1, unit: "pcs", hsn: "12" }])).toThrow(/HSN/);
  });
  it("builds a digest for the AI capabilities and a derived title", () => {
    const parsed = enquiryLinesSchema.parse([{ itemName: "Bolt", quantity: 5, unit: "kg", spec: "M8" }, { itemName: "Nut", quantity: 9, unit: "kg" }]);
    expect(linesDigest(parsed)).toBe("Line items (2):\n1. Bolt x 5 kg - M8\n2. Nut x 9 kg");
    expect(linesDigest(parsed.slice(1))).toBe("");
    expect(deriveTitle(parsed)).toBe("Bolt and 1 more item");
    expect(deriveTitle([{ itemName: "A" }])).toBe("A requirement");
    expect(linesDigest(Array.from({ length: 50 }, () => ({ itemName: "x".repeat(100), spec: null, quantity: 1, unit: "pcs", hsn: null })), 500)).toMatch(/more line\(s\)$/);
  });
});

describe("line amounts (paise, bigint)", () => {
  it("rounds half up", () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(4n, 3n)).toBe(1n);
  });
  it("adds GST on top when prices exclude it", () => {
    expect(lineAmounts(10_000n, 10, 18, false)).toEqual({ subtotalPaise: 100_000n, gstPaise: 18_000n, totalPaise: 118_000n });
    expect(lineAmounts(10_000n, 10, null, null)).toEqual({ subtotalPaise: 100_000n, gstPaise: 0n, totalPaise: 100_000n });
    expect(lineAmounts(333n, 3, 5, null).gstPaise).toBe(50n); // 999 * 5% = 49.95 -> 50
  });
  it("splits the included GST out when prices include it", () => {
    expect(lineAmounts(11_800n, 1, 18, true)).toEqual({ subtotalPaise: 10_000n, gstPaise: 1_800n, totalPaise: 11_800n });
  });
});

describe("prepareQuoteLines", () => {
  it("computes totals server-side, allows partial quotes and mirrors the first priced line", () => {
    const p = prepareQuoteLines([{ ordinal: 3, unitPricePaise: 100, gstRatePct: 18 }, { enquiryLineId: lines[1]!.id, unitPricePaise: 250, leadTimeDays: 5 }], lines, false);
    expect(p.quotedLineCount).toBe(2);
    expect(p.subtotalPaise).toBe(100n * 30n + 250n * 20n);
    expect(p.gstPaise).toBe(540n);
    expect(p.totalPaise).toBe(3000n + 5000n + 540n);
    expect(p.first).toEqual({ unitPricePaise: 250n, quantity: 20, unit: "pcs" });
    expect(p.rows.find((r) => r.enquiryLineId === lines[0]!.id)).toBeUndefined();
  });
  it("handles can't-supply lines (no price counted) and requires one priced line", () => {
    const p = prepareQuoteLines([{ ordinal: 1, cantSupply: true, unitPricePaise: 999 }, { ordinal: 2, unitPricePaise: 10 }], lines, null);
    expect(p.rows[0]).toMatchObject({ cantSupply: true, unitPricePaise: null, amounts: null });
    expect(p.totalPaise).toBe(200n);
    expect(() => prepareQuoteLines([{ ordinal: 1, cantSupply: true }], lines, null)).toThrow(/at least one line/);
    expect(() => prepareQuoteLines([], lines, null)).toThrow();
  });
  it("rejects unknown, duplicate, mismatched and unpriced lines", () => {
    expect(() => prepareQuoteLines([{ ordinal: 9, unitPricePaise: 1 }], lines, null)).toThrow(/does not belong/);
    expect(() => prepareQuoteLines([{ ordinal: 1, unitPricePaise: 1 }, { enquiryLineId: lines[0]!.id, unitPricePaise: 2 }], lines, null)).toThrow(/twice/);
    expect(() => prepareQuoteLines([{ enquiryLineId: lines[0]!.id, ordinal: 2, unitPricePaise: 1 }], lines, null)).toThrow(/disagree/);
    expect(() => prepareQuoteLines([{ ordinal: 1 }], lines, null)).toThrow(/unit price/);
    expect(() => prepareQuoteLines([{ unitPricePaise: 5 }], lines, null)).toThrow(/requirement line/);
    expect(() => prepareQuoteLines([{ ordinal: 1, unitPricePaise: 5, gstRatePct: 99 }], lines, null)).toThrow();
  });
});

describe("lowestPerLine", () => {
  const v = (enquiryLineId: string, total: number | null, cant = false): QuoteLineView => ({
    id: enquiryLineId + total, enquiryLineId, ordinal: 1, unitPricePaise: total, gstRatePct: null, leadTimeDays: null, cantSupply: cant, notes: null, quantity: 1,
    lineSubtotalPaise: total, lineGstPaise: 0, lineTotalPaise: total,
  });
  it("marks the lowest payable per line, all ties, and ignores can't-supply or skipped lines", () => {
    const [a, b, c] = lines.map((l) => l.id) as [string, string, string];
    const m = lowestPerLine(
      [
        { quoteId: "qA", lines: [v(a, 100), v(b, 50), v(c, 70, true)] },
        { quoteId: "qB", lines: [v(a, 100), v(c, 90)] },
        { quoteId: "qC", lines: [v(b, 60)] },
      ],
      [a, b, c],
    );
    expect([...m.get(a)!].sort()).toEqual(["qA", "qB"]);
    expect([...m.get(b)!]).toEqual(["qA"]);
    expect([...m.get(c)!]).toEqual(["qB"]);
  });
});
