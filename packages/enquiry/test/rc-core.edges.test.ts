// Rate-contract rules: validation and pricing boundaries (pure, no database).
import { describe, expect, it } from "vitest";
import { normaliseItem, normaliseTerms, priceCallOff, thresholdsCrossed, usedPercent, type RcItemInput, type RcTermsInput } from "../src/rc-core";

const item = (over: Partial<RcItemInput> = {}): RcItemInput => ({ description: "Corrugated box", unit: "pcs", unitPricePaise: 2500, gstRateBps: 1800, ...over });
const terms = (over: Partial<RcTermsInput> = {}): RcTermsInput => ({ validFrom: "2026-10-01", validTo: "2027-09-30", paymentTermsDays: 30, priceBasis: "delivered", items: [item()], ...over });
const KEY = "11111111-1111-4111-8111-111111111111";

describe("normaliseItem", () => {
  it.each([
    ["short description", { description: "x" }],
    ["missing description", { description: undefined as unknown as string }],
    ["bad hsn", { hsn: "12ab" }],
    ["blank unit", { unit: " " }],
    ["long unit", { unit: "u".repeat(33) }],
    ["zero price", { unitPricePaise: 0 }],
    ["fractional price", { unitPricePaise: 1.5 }],
    ["bad gst", { gstRateBps: 4001 }],
    ["bad item key", { itemKey: "nope" }],
    ["bad listing id", { listingId: "nope" }],
    ["fractional moq", { moq: 1.5 }],
    ["zero cap", { quantityCap: 0 }],
    ["moq above cap", { moq: 10, quantityCap: 5 }],
    ["cap too large for the price", { quantityCap: 1_000_000_000, unitPricePaise: 1_000_000_000_000 }],
    ["unknown variation", { variationKind: "floating" as never }],
    ["indexed without cap", { variationKind: "indexed", variationNote: "LME copper" }],
    ["indexed with huge cap", { variationKind: "indexed", variationCapBps: 99_999_999, variationNote: "LME copper" }],
    ["indexed without a note", { variationKind: "indexed", variationCapBps: 500 }],
    ["indexed with a one-letter note", { variationKind: "indexed", variationCapBps: 500, variationNote: "x" }],
    ["indexed with a long note", { variationKind: "indexed", variationCapBps: 500, variationNote: "n".repeat(301) }],
  ] as [string, Partial<RcItemInput>][])("rejects %s", (_n, over) => {
    expect(() => normaliseItem(item(over), "Item 2")).toThrowError(/^(?:Item 2: |Keep this|whole number|from 1 to)/);
  });

  it("lowercases keys, empties optional text to null and keeps an indexed band", () => {
    const n = normaliseItem(item({ itemKey: KEY.toUpperCase(), listingId: KEY.toUpperCase(), hsn: "", variationKind: "indexed", variationCapBps: 500, variationNote: " LME copper monthly " }), "Item 1");
    expect(n).toMatchObject({ itemKey: KEY, listingId: KEY, hsn: null, variationKind: "indexed", variationCapBps: 500, variationNote: "LME copper monthly" });
    expect(normaliseItem(item({ itemKey: "", listingId: null, hsn: "4819" }), "Item 1")).toMatchObject({ itemKey: null, listingId: null, hsn: "4819", variationKind: "fixed", variationCapBps: null });
  });
});

describe("normaliseTerms", () => {
  const bad = (over: Partial<RcTermsInput>, re: RegExp) => expect(() => normaliseTerms(terms(over), "2026-10-05")).toThrow(re);

  it("rejects bad dates, periods and terms", () => {
    bad({ validFrom: "x" }, /start date/);
    bad({ validTo: "x" }, /end date/);
    bad({ validFrom: "2026-10-10", validTo: "2026-10-01" }, /before the start/);
    bad({ validFrom: "2026-10-01", validTo: "2033-10-01" }, /5 years/);
    bad({ validFrom: "2026-01-01", validTo: "2026-10-04" }, /in the past/);
    bad({ paymentTermsDays: -1 }, /payment terms/);
    bad({ paymentTermsDays: 1.5 }, /payment terms/);
    bad({ priceBasis: "magic" as never }, /prices include/);
    bad({ valueCapPaise: 0 }, /value cap/);
    bad({ valueCapPaise: 1.5 }, /value cap/);
  });

  it("accepts a valid set, trims text and keeps a value cap", () => {
    const t = normaliseTerms(terms({ valueCapPaise: 5_000_000, notes: "  net of freight  ", changeNote: "  " }), "2026-10-05");
    expect(t).toMatchObject({ valueCapPaise: 5_000_000, notes: "net of freight", changeNote: null, priceBasis: "delivered" });
    expect(t.items).toHaveLength(1);
  });
});

describe("priceCallOff", () => {
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const items = [
    { itemKey: A, description: "Box", unit: "pcs", unitPricePaise: 1000, moq: 10, quantityCap: 100, variationKind: "fixed", variationCapBps: null },
    { itemKey: B, description: "Wire", unit: "kg", unitPricePaise: 80_000, moq: null, quantityCap: null, variationKind: "indexed", variationCapBps: 500 },
  ];
  const none = { byItem: new Map(), valuePaise: 0 };
  const run = (lines: { itemKey: string; quantity: number; unitPricePaise?: number | null }[], cap: number | null = null, used = none) => priceCallOff(items as never, cap, used as never, lines as never);

  it("rejects an empty call-off, too many lines, unknown and repeated items", () => {
    expect(() => run([])).toThrow(/at least one item/);
    expect(() => priceCallOff(items as never, null, none as never, null as never)).toThrow(/at least one item/);
    expect(() => run(Array.from({ length: 101 }, () => ({ itemKey: A, quantity: 10 })))).toThrow(/up to/);
    expect(() => run([{ itemKey: "zzz", quantity: 1 }])).toThrow(/not on the contract/);
    expect(() => run([{ itemKey: undefined as never, quantity: 1 }])).toThrow(/not on the contract/);
    expect(() => run([{ itemKey: A, quantity: 10 }, { itemKey: A.toUpperCase(), quantity: 10 }])).toThrow(/listed twice/);
  });

  it("enforces whole quantities, the minimum and the quantity cap with what is left", () => {
    expect(() => run([{ itemKey: A, quantity: 0 }])).toThrow(/whole quantity/);
    expect(() => run([{ itemKey: A, quantity: 1.5 }])).toThrow(/whole quantity/);
    expect(() => run([{ itemKey: A, quantity: 5 }])).toThrow(/minimum per call-off for Box is 10 pcs/);
    expect(() => run([{ itemKey: A, quantity: 60 }], null, { byItem: new Map([[A, { quantity: 50 }]]), valuePaise: 0 } as never)).toThrow(/only 50 pcs of Box is left/);
    expect(() => run([{ itemKey: A, quantity: 20 }], null, { byItem: new Map([[A, { quantity: 100 }]]), valuePaise: 0 } as never)).toThrow(/only 0 pcs/);
  });

  it("locks a fixed price, lets an indexed price move inside its band and rejects the rest", () => {
    expect(() => run([{ itemKey: A, quantity: 10, unitPricePaise: 900 }])).toThrow(/fixed by the contract/);
    expect(run([{ itemKey: A, quantity: 10, unitPricePaise: 1000 }]).lines[0]!.appliedPricePaise).toBe(1000);
    expect(() => run([{ itemKey: B, quantity: 1, unitPricePaise: 80_000.5 }])).toThrow(/whole paise/);
    expect(() => run([{ itemKey: B, quantity: 1, unitPricePaise: 90_000 }])).toThrow(/within 5%/);
    expect(() => run([{ itemKey: B, quantity: 1, unitPricePaise: 70_000 }])).toThrow(/within 5%/);
    const ok = run([{ itemKey: B, quantity: 2, unitPricePaise: 83_000 }]);
    expect(ok.lines[0]).toMatchObject({ contractPricePaise: 80_000, appliedPricePaise: 83_000, taxablePaise: 166_000 });
    expect(run([{ itemKey: B, quantity: 2, unitPricePaise: null }]).lines[0]!.appliedPricePaise).toBe(80_000);
  });

  it("refuses a line that is too large and a call-off past the value cap, saying what is left", () => {
    expect(() => run([{ itemKey: B, quantity: 2_000_000_000 }])).toThrow(/quantity|too large/);
    expect(() => run([{ itemKey: B, quantity: 10 }], 500_000)).toThrow(/value limit.*₹5,000/);
    expect(() => run([{ itemKey: B, quantity: 1 }], 500_000, { byItem: new Map(), valuePaise: 900_000 })).toThrow(/₹0 is left/);
    expect(run([{ itemKey: B, quantity: 5 }, { itemKey: A, quantity: 10 }], 1_000_000).taxablePaise).toBe(410_000);
  });
});

describe("consumption maths", () => {
  it("usedPercent rounds down, caps at 100 and treats a zero cap as full", () => {
    expect(usedPercent(79, 100)).toBe(79);
    expect(usedPercent(799, 1000)).toBe(79);
    expect(usedPercent(500, 100)).toBe(100);
    expect(usedPercent(1, 0)).toBe(100);
  });

  it("thresholdsCrossed reports each threshold once, none without a cap", () => {
    expect(thresholdsCrossed(0, 79, 100)).toEqual([]);
    expect(thresholdsCrossed(0, 80, 100)).toEqual([80]);
    expect(thresholdsCrossed(80, 99, 100)).toEqual([]);
    expect(thresholdsCrossed(79, 100, 100)).toEqual([80, 100]);
    expect(thresholdsCrossed(100, 150, 100)).toEqual([]);
    expect(thresholdsCrossed(0, 50, null)).toEqual([]);
    expect(thresholdsCrossed(0, 50, 0)).toEqual([]);
  });
});
