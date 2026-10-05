import { describe, expect, it } from "vitest";
import {
  expiryReminderStage, formatRcNumber, normaliseTerms, phaseOf, priceCallOff, renewalDates, sumConsumption, thresholdsCrossed, usedPercent, variationBand,
  type ContractItemForCallOff, type RcTermsInput,
} from "../src/rc-core";

const TODAY = "2026-10-06";
const K1 = "11111111-1111-4111-8111-111111111111";
const K2 = "22222222-2222-4222-8222-222222222222";

const terms = (over: Partial<RcTermsInput> = {}): RcTermsInput => ({
  validFrom: "2026-10-06", validTo: "2027-10-05", paymentTermsDays: 30, priceBasis: "delivered",
  items: [{ description: "Corrugated box 12x10", unit: "pcs", unitPricePaise: 2500, gstRateBps: 1800 }], ...over,
});

describe("normaliseTerms", () => {
  it("accepts a plain fixed-price contract and trims text", () => {
    const t = normaliseTerms(terms({ notes: "  Deliver to dock 2 " }), TODAY);
    expect(t.notes).toBe("Deliver to dock 2");
    expect(t.items[0]).toMatchObject({ variationKind: "fixed", variationCapBps: null, moq: null, quantityCap: null, itemKey: null });
  });

  it("rejects bad dates: reversed, in the past, malformed, longer than five years", () => {
    expect(() => normaliseTerms(terms({ validTo: "2026-10-01" }), TODAY)).toThrow(/cannot be before/);
    expect(() => normaliseTerms(terms({ validFrom: "2026-01-01", validTo: "2026-09-30" }), TODAY)).toThrow(/past/);
    expect(() => normaliseTerms(terms({ validFrom: "2026-13-01" }), TODAY)).toThrow(/valid start/);
    expect(() => normaliseTerms(terms({ validTo: "2032-12-31" }), TODAY)).toThrow(/5 years/);
  });

  it("validates payment terms, price basis and the number of items", () => {
    expect(() => normaliseTerms(terms({ paymentTermsDays: -1 }), TODAY)).toThrow(/payment terms/);
    expect(() => normaliseTerms(terms({ priceBasis: "x" as never }), TODAY)).toThrow(/prices include/);
    expect(() => normaliseTerms(terms({ items: [] }), TODAY)).toThrow(/at least one/);
    const many = Array.from({ length: 51 }, (_, i) => ({ description: `Item ${i}`, unit: "pcs", unitPricePaise: 100, gstRateBps: 1800 }));
    expect(() => normaliseTerms(terms({ items: many }), TODAY)).toThrow(/up to 50/);
  });

  it("validates item fields: price, GST, HSN, MOQ against cap, duplicate keys", () => {
    const item = (o: object) => terms({ items: [{ description: "Box", unit: "pcs", unitPricePaise: 100, gstRateBps: 1800, ...o }] });
    expect(() => normaliseTerms(item({ unitPricePaise: 0 }), TODAY)).toThrow(/unit price/);
    expect(() => normaliseTerms(item({ unitPricePaise: 1.5 }), TODAY)).toThrow(/unit price/);
    expect(() => normaliseTerms(item({ gstRateBps: 5000 }), TODAY)).toThrow(/GST/);
    expect(() => normaliseTerms(item({ hsn: "12" + "3".repeat(7) }), TODAY)).toThrow(/HSN/);
    expect(() => normaliseTerms(item({ moq: 10, quantityCap: 5 }), TODAY)).toThrow(/cannot exceed/);
    expect(() => normaliseTerms(item({ itemKey: "not-a-uuid" }), TODAY)).toThrow(/unknown item/);
    expect(() => normaliseTerms(terms({ items: [
      { itemKey: K1, description: "A box", unit: "pcs", unitPricePaise: 100, gstRateBps: 0 },
      { itemKey: K1, description: "B box", unit: "pcs", unitPricePaise: 100, gstRateBps: 0 },
    ] }), TODAY)).toThrow(/twice/);
  });

  it("an indexed price needs a cap within 50% and a reference; a fixed price carries neither", () => {
    const item = (o: object) => terms({ items: [{ description: "Copper wire", unit: "kg", unitPricePaise: 80000, gstRateBps: 1800, ...o }] });
    expect(() => normaliseTerms(item({ variationKind: "indexed" }), TODAY)).toThrow(/needs a cap/);
    expect(() => normaliseTerms(item({ variationKind: "indexed", variationCapBps: 6000, variationNote: "LME monthly" }), TODAY)).toThrow(/variation cap/);
    expect(() => normaliseTerms(item({ variationKind: "indexed", variationCapBps: 500 }), TODAY)).toThrow(/indexed to/);
    const ok = normaliseTerms(item({ variationKind: "indexed", variationCapBps: 500, variationNote: "LME copper monthly average" }), TODAY);
    expect(ok.items[0]).toMatchObject({ variationKind: "indexed", variationCapBps: 500 });
    const fixed = normaliseTerms(item({ variationKind: "fixed", variationCapBps: 500, variationNote: "ignored" }), TODAY);
    expect(fixed.items[0]).toMatchObject({ variationCapBps: null, variationNote: null });
  });

  it("has no auto-renew concept: terms accept no such field", () => {
    const t = normaliseTerms({ ...terms(), autoRenew: true } as RcTermsInput, TODAY);
    expect(Object.keys(t)).not.toContain("autoRenew");
  });
});

describe("numbering, phases, reminders and renewal dates", () => {
  it("formats RC numbers", () => expect(formatRcNumber("2026-27", 3)).toBe("RC/26-27/000003"));

  it("phaseOf: before, within and after the accepted dates", () => {
    expect(phaseOf("2026-11-01", "2027-03-31", "2026-10-06")).toBe("not_started");
    expect(phaseOf("2026-11-01", "2027-03-31", "2026-11-01")).toBe("in_force");
    expect(phaseOf("2026-11-01", "2027-03-31", "2027-03-31")).toBe("in_force");
    expect(phaseOf("2026-11-01", "2027-03-31", "2027-04-01")).toBe("ended");
  });

  it("expiryReminderStage: 30 inside a month, 7 inside a week (current stage only), none after the end", () => {
    expect(expiryReminderStage("2026-12-31", "2026-10-06")).toBeNull();
    expect(expiryReminderStage("2026-11-05", "2026-10-06")).toBe(30);
    expect(expiryReminderStage("2026-11-06", "2026-10-06")).toBeNull();
    expect(expiryReminderStage("2026-10-13", "2026-10-06")).toBe(7);
    expect(expiryReminderStage("2026-10-06", "2026-10-06")).toBe(7);
    expect(expiryReminderStage("2026-10-05", "2026-10-06")).toBeNull();
  });

  it("renewalDates start the day after the old end (or today) and keep the length", () => {
    expect(renewalDates("2026-04-01", "2027-03-31", "2027-02-01")).toEqual({ validFrom: "2027-04-01", validTo: "2028-03-30" /* same number of days, across a leap day */ });
    expect(renewalDates("2026-04-01", "2026-09-30", "2026-12-01")).toEqual({ validFrom: "2026-12-01", validTo: "2027-06-01" });
  });
});

const ITEMS: ContractItemForCallOff[] = [
  { itemKey: K1, description: "Box", unit: "pcs", unitPricePaise: 2500, moq: 100, quantityCap: 1000, variationKind: "fixed", variationCapBps: null },
  { itemKey: K2, description: "Copper wire", unit: "kg", unitPricePaise: 80000, moq: null, quantityCap: null, variationKind: "indexed", variationCapBps: 500 },
];
const none = { byItem: new Map(), valuePaise: 0 };

describe("priceCallOff", () => {
  it("locks the contract price and totals the taxable value", () => {
    const r = priceCallOff(ITEMS, null, none, [{ itemKey: K1, quantity: 200 }, { itemKey: K2, quantity: 3 }]);
    expect(r.lines).toEqual([
      expect.objectContaining({ lineNo: 1, quantity: 200, contractPricePaise: 2500, appliedPricePaise: 2500, taxablePaise: 500_000 }),
      expect.objectContaining({ lineNo: 2, quantity: 3, appliedPricePaise: 80000, taxablePaise: 240_000 }),
    ]);
    expect(r.taxablePaise).toBe(740_000);
  });

  it("a fixed price cannot be overridden, even by the same number the contract holds being changed", () => {
    expect(() => priceCallOff(ITEMS, null, none, [{ itemKey: K1, quantity: 200, unitPricePaise: 2400 }])).toThrow(/fixed by the contract/);
    expect(priceCallOff(ITEMS, null, none, [{ itemKey: K1, quantity: 200, unitPricePaise: 2500 }]).lines[0]!.appliedPricePaise).toBe(2500);
  });

  it("an indexed item may move inside its band and no further", () => {
    expect(variationBand(80000, 500)).toEqual({ min: 76000, max: 84000 });
    expect(priceCallOff(ITEMS, null, none, [{ itemKey: K2, quantity: 1, unitPricePaise: 84000 }]).lines[0]).toMatchObject({ contractPricePaise: 80000, appliedPricePaise: 84000 });
    expect(() => priceCallOff(ITEMS, null, none, [{ itemKey: K2, quantity: 1, unitPricePaise: 84001 }])).toThrow(/within 5%/);
    expect(() => priceCallOff(ITEMS, null, none, [{ itemKey: K2, quantity: 1, unitPricePaise: 75999 }])).toThrow(/within 5%/);
  });

  it("enforces the MOQ per call-off, whole positive quantities and known, distinct items", () => {
    expect(() => priceCallOff(ITEMS, null, none, [{ itemKey: K1, quantity: 99 }])).toThrow(/minimum per call-off for Box is 100/);
    expect(() => priceCallOff(ITEMS, null, none, [{ itemKey: K1, quantity: 0 }])).toThrow(/whole quantity/);
    expect(() => priceCallOff(ITEMS, null, none, [{ itemKey: K1, quantity: 1.5 }])).toThrow(/whole quantity/);
    expect(() => priceCallOff(ITEMS, null, none, [{ itemKey: "33333333-3333-4333-8333-333333333333", quantity: 100 }])).toThrow(/not on the contract/);
    expect(() => priceCallOff(ITEMS, null, none, [{ itemKey: K1, quantity: 100 }, { itemKey: K1, quantity: 100 }])).toThrow(/twice/);
    expect(() => priceCallOff(ITEMS, null, none, [])).toThrow(/at least one/);
  });

  it("enforces the quantity cap against earlier consumption and says how much is left", () => {
    const used = sumConsumption([{ itemKey: K1, quantity: 900, taxablePaise: 2_250_000 }]);
    expect(() => priceCallOff(ITEMS, null, used, [{ itemKey: K1, quantity: 101 }])).toThrow(/only 100 pcs of Box is left/);
    expect(priceCallOff(ITEMS, null, used, [{ itemKey: K1, quantity: 100 }]).lines).toHaveLength(1);
  });

  it("enforces the contract value cap across items and earlier call-offs", () => {
    const used = sumConsumption([{ itemKey: K1, quantity: 100, taxablePaise: 250_000 }]);
    expect(() => priceCallOff(ITEMS, 700_000, used, [{ itemKey: K1, quantity: 200 }, { itemKey: K2, quantity: 1 }])).toThrow(/value limit/);
    expect(priceCallOff(ITEMS, 830_000, used, [{ itemKey: K1, quantity: 100 }, { itemKey: K2, quantity: 4 }]).taxablePaise).toBe(570_000);
  });
});

describe("consumption thresholds", () => {
  it("usedPercent rounds down and stops at 100", () => {
    expect(usedPercent(799, 1000)).toBe(79);
    expect(usedPercent(800, 1000)).toBe(80);
    expect(usedPercent(1500, 1000)).toBe(100);
  });

  it("thresholdsCrossed reports 80 and 100 once, as consumption passes them", () => {
    expect(thresholdsCrossed(0, 790, 1000)).toEqual([]);
    expect(thresholdsCrossed(790, 800, 1000)).toEqual([80]);
    expect(thresholdsCrossed(800, 999, 1000)).toEqual([]);
    expect(thresholdsCrossed(999, 1000, 1000)).toEqual([100]);
    expect(thresholdsCrossed(100, 1000, 1000)).toEqual([80, 100]);
    expect(thresholdsCrossed(0, 5000, null)).toEqual([]);
  });
});
