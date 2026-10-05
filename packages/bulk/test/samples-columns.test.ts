import { describe, expect, it } from "vitest";
import { validateRows, type RawRow, type ValidationContext } from "../src";
import { BASE_COLUMNS } from "../src/columns";
import { CATS } from "./fixtures";

const base: ValidationContext = { categories: CATS, zipImages: [], isZip: false, mode: "upsert", submitForReview: false, existing: new Map() };
const row = (cells: Record<string, string>): RawRow => ({ row: 2, cells: { sku: "S1", title: "A title", category: "ms-pipes", ...cells } });
const run = (cells: Record<string, string>, ctx: Partial<ValidationContext> = {}) => validateRows([row(cells)], { ...base, ...ctx });
const msgs = (r: ReturnType<typeof run>) => r.errors.map((e) => `${e.column}: ${e.message}`);

describe("sample columns (docs/design/samples.md)", () => {
  it("are optional columns with guidance", () => {
    for (const key of ["sample_available", "sample_price_rupees", "sample_max_qty", "sample_dispatch_days", "sample_min_buyer_tier"]) {
      const c = BASE_COLUMNS.find((x) => x.key === key);
      expect(c, key).toBeDefined();
      expect(c!.required).toBe(false);
      expect(c!.hint.length).toBeGreaterThan(20);
    }
  });

  it("parses a complete sample setting into typed values (price in paise)", () => {
    const r = run({ sample_available: "Yes", sample_price_rupees: "150", sample_max_qty: "10", sample_dispatch_days: "3", sample_min_buyer_tier: "2" });
    expect(r.errors).toEqual([]);
    expect(r.valid[0]).toMatchObject({ sampleAvailable: true, samplePricePaise: 15000, sampleMaxQty: 10, sampleDispatchDays: 3, sampleMinBuyerTier: 2 });
  });

  it("a free sample is 0 and blank cells stay undefined (leave unchanged on update)", () => {
    expect(run({ sample_available: "y", sample_price_rupees: "0" }).valid[0]).toMatchObject({ sampleAvailable: true, samplePricePaise: 0 });
    const blank = run({}).valid[0]!;
    expect(blank.sampleAvailable).toBeUndefined();
    expect(blank.sampleMaxQty).toBeUndefined();
  });

  it("switching samples off is allowed and warns that the details are ignored", () => {
    const r = run({ sample_available: "no", sample_max_qty: "5" });
    expect(r.errors).toEqual([]);
    expect(r.valid[0]).toMatchObject({ sampleAvailable: false });
    expect(r.warnings.join(" ")).toContain("ignored");
  });

  it.each([
    [{ sample_available: "maybe" }, "sample_available: sample_available must be yes or no"],
    [{ sample_available: "yes", sample_price_rupees: "ten" }, "sample_price_rupees:"],
    [{ sample_available: "yes", sample_max_qty: "0" }, "sample_max_qty: Sample max quantity must be a whole number"],
    [{ sample_available: "yes", sample_dispatch_days: "91" }, "sample_dispatch_days:"],
    [{ sample_available: "yes", sample_min_buyer_tier: "4" }, "sample_min_buyer_tier:"],
    [{ sample_max_qty: "5" }, "sample_available: Set sample_available to yes"],
  ])("rejects %j", (cells, expected) => {
    expect(msgs(run(cells)).join("\n")).toContain(expected);
  });

  it("details without sample_available are fine on an existing SKU (the listing may already offer samples)", () => {
    const existing = new Map([["S1", { id: "l1", status: "published" as const }]]);
    expect(run({ sample_max_qty: "5" }, { existing }).errors).toEqual([]);
  });
});
