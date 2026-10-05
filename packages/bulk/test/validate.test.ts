import { describe, expect, it } from "vitest";
import { buildErrorReport, parseImportFile, resolveImage, rupeesToPaise, validateRows, type RawRow, type ValidationContext } from "../src";
import { CATS, csv, GOOD } from "./fixtures";

const base: ValidationContext = { categories: CATS, zipImages: ["box-1.jpg", "sub/Box-2.PNG", "a/dup.jpg", "b/dup.jpg"], isZip: true, mode: "upsert", submitForReview: false, existing: new Map() };
const row = (cells: Record<string, string>, n = 2): RawRow => ({ row: n, cells: { sku: "S1", title: "A title", category: "ms-pipes", ...cells } });
const run = (cells: Record<string, string>, ctx: Partial<ValidationContext> = {}) => validateRows([row(cells)], { ...base, ...ctx });
const msgs = (r: ReturnType<typeof run>) => r.errors.map((e) => `${e.column}: ${e.message}`);

describe("validateRows matrix", () => {
  it("accepts a fully valid row and converts values", () => {
    const r = run({ description: "A long enough description", price_rupees: "1,250.5", price_unit: "kg", moq: "10", moq_unit: "kg", hsn: "7306", language: "HI", category: "PACKAGING-BOXES", "attr:gsm": "300", "attr:material": "kraft", image_files: "box-1.jpg, images/sub/box-2.png", image_urls: "https://cdn.example.com/a.jpg" });
    expect(r.errors).toEqual([]);
    expect(r.valid[0]).toMatchObject({ sku: "S1", pricePaise: 125050, moq: 10, hsn: "7306", language: "hi", categorySlug: "packaging-boxes", attributes: { gsm: 300, material: "Kraft" }, imageFiles: ["box-1.jpg", "sub/Box-2.PNG"], imageUrls: ["https://cdn.example.com/a.jpg"] });
  });
  it("accepts category by name and leaves blank optionals undefined", () => {
    const r = run({ category: "MS pipes" });
    expect(r.valid[0]).toMatchObject({ categorySlug: "ms-pipes", pricePaise: undefined, moq: undefined, language: undefined, imageFiles: [] });
  });

  it.each([
    [{ sku: "" }, "sku: SKU is required"],
    [{ sku: "bad sku!" }, "sku: SKU may only contain"],
    [{ sku: "x".repeat(65) }, "sku: SKU may only contain"],
    [{ title: "ab" }, "title: Title must be"],
    [{ title: "x".repeat(201) }, "title: Title must be"],
    [{ category: "" }, "category: Category is required"],
    [{ category: "nope" }, 'category: Unknown category "nope"'],
    [{ category: "weapons" }, "not permitted"],
    [{ description: "x".repeat(5001) }, "description: Description is longer"],
    [{ price_rupees: "abc" }, "price_rupees: Price must be"],
    [{ price_rupees: "1.234" }, "price_rupees: Price must be"],
    [{ price_rupees: "-5" }, "price_rupees: Price must be"],
    [{ moq: "0" }, "moq: MOQ must be a whole number"],
    [{ moq: "2.5" }, "moq: MOQ must be a whole number"],
    [{ moq: "x" }, "moq: MOQ must be a whole number"],
    [{ price_unit: "u".repeat(31) }, "price_unit: Unit is longer"],
    [{ hsn: "123" }, "hsn: HSN must be 4 to 8 digits"],
    [{ hsn: "123456789" }, "hsn: HSN must be 4 to 8 digits"],
    [{ hsn: "48ab" }, "hsn: HSN must be 4 to 8 digits"],
    [{ language: "xx" }, "language: Language must be one of"],
    [{ category: "packaging-boxes", "attr:gsm": "heavy" }, "attr:gsm: GSM must be a number"],
    [{ category: "packaging-boxes", "attr:material": "Gold" }, "attr:material: Material must be one of"],
    [{ category: "packaging-boxes", "attr:color": "x".repeat(501) }, "attr:color: Colour is longer"],
    [{ "attr:gsm": "100" }, 'attr:gsm: "gsm" is not an attribute of category "MS pipes"'],
    [{ image_files: "missing.jpg" }, 'image_files: Image "missing.jpg" was not found'],
    [{ image_files: "dup.jpg" }, "image_files: Image \"dup.jpg\" is ambiguous"],
    [{ image_files: "a.jpg,b.jpg,c.jpg,d.jpg,e.jpg,f.jpg,g.jpg,h.jpg,i.jpg" }, "image_files: At most 8"],
    [{ image_urls: "http://insecure.example.com/a.jpg" }, "image_urls:"],
    [{ image_urls: "not a url" }, "image_urls:"],
  ])("row error %j -> %s", (cells, expected) => {
    const r = run(cells);
    expect(r.valid).toEqual([]);
    expect(r.invalidRows.has(2)).toBe(true);
    expect(msgs(r).join("\n")).toContain(expected);
  });

  it("image_files requires a zip", () => {
    expect(msgs(run({ image_files: "a.jpg" }, { isZip: false, zipImages: [] }))[0]).toContain("needs a ZIP upload");
  });

  it("flags duplicate SKUs within the file, naming the first row", () => {
    const r = validateRows([row({ sku: "D1" }, 2), row({ sku: "D1" }, 3), row({ sku: "D2" }, 4)], base);
    expect(r.errors).toEqual([{ row: 3, column: "sku", message: 'Duplicate SKU "D1" (also on row 2)' }]);
    expect(r.valid.map((v) => v.sku)).toEqual(["D1", "D2"]);
  });

  it("create mode rejects existing SKUs; upsert allows them; archived listings cannot be updated", () => {
    const existing = new Map([["S1", { id: "x", status: "draft" as const }]]);
    expect(msgs(run({}, { mode: "create", existing }))[0]).toContain("already exists");
    expect(run({}, { mode: "upsert", existing }).errors).toEqual([]);
    expect(msgs(run({}, { existing: new Map([["S1", { id: "x", status: "archived" as const }]]) }))[0]).toContain("archived");
  });

  it("submitForReview demands a description and required attributes for new SKUs only", () => {
    const r = run({ category: "packaging-boxes" }, { submitForReview: true });
    expect(msgs(r).join("\n")).toContain("Description must be at least 10");
    expect(msgs(r).join("\n")).toContain("GSM is required");
    const existing = new Map([["S1", { id: "x", status: "draft" as const }]]);
    expect(run({ category: "packaging-boxes" }, { submitForReview: true, existing }).errors).toEqual([]);
    expect(run({ category: "packaging-boxes", description: "Long enough text", "attr:gsm": "200" }, { submitForReview: true }).errors).toEqual([]);
  });

  it("warns about unknown columns but ignores read-only export columns", () => {
    const r = run({}, { fileKeys: ["sku", "status", "review_state", "live_version", "attr:x", "mystery"] });
    expect(r.warnings).toEqual(['Column "mystery" is not recognised and was ignored']);
  });

  it("collects every error of a row, and only bad rows are invalid", () => {
    const r = validateRows([row({ sku: "", title: "x", hsn: "1" }, 2), row({}, 3)], base);
    expect(r.errors.filter((e) => e.row === 2)).toHaveLength(3);
    expect([...r.invalidRows]).toEqual([2]);
    expect(r.valid).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("rupeesToPaise avoids float error", () => {
    expect(rupeesToPaise("0.29")).toBe(29);
    expect(rupeesToPaise("19.9")).toBe(1990);
    expect(rupeesToPaise("₹1,00,000")).toBe(10_000_000);
    expect(rupeesToPaise("Rs. 5")).toBe(500);
    expect(rupeesToPaise("")).toBeNull();
    expect(rupeesToPaise("1e5")).toBeNull();
  });
  it("resolveImage is case-insensitive and understands folders", () => {
    expect(resolveImage("BOX-1.JPG", ["box-1.jpg"])).toEqual({ path: "box-1.jpg" });
    expect(resolveImage("./images/sub/x.png", ["sub/x.png"])).toEqual({ path: "sub/x.png" });
    expect(resolveImage("x.png", ["sub/x.png"])).toEqual({ path: "sub/x.png" });
  });
});

describe("buildErrorReport", () => {
  it("csv: original columns of failing rows + errors column, no silent drops", async () => {
    const parsed = await parseImportFile({ bytes: csv(GOOD, "BAD 1,x,nope,,abc"), filename: "p.csv" });
    const res = validateRows(parsed.rows, { ...base, isZip: false });
    expect(res.valid).toHaveLength(1);
    const { bytes, ext } = await buildErrorReport({ headers: parsed.headers, keys: parsed.keys, rows: parsed.rows, errors: res.errors, format: "csv" });
    expect(ext).toBe("csv");
    const text = bytes.toString("utf8");
    const lines = text.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]!.startsWith("row,sku*,title*")).toBe(true);
    expect(lines[0]!.endsWith(",errors")).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("BAD 1");
    expect(lines[1]).toContain("sku: SKU may only contain");
    // the report is itself an importable file (extra columns ignored)
    const again = await parseImportFile({ bytes, filename: "errors.csv" });
    expect(again.rows[0]!.cells.sku).toBe("BAD 1");
  });
  it("xlsx: Errors sheet", async () => {
    const parsed = await parseImportFile({ bytes: csv("BAD 1,x,nope"), filename: "p.csv" });
    const res = validateRows(parsed.rows, base);
    const { bytes, ext } = await buildErrorReport({ headers: parsed.headers, keys: parsed.keys, rows: parsed.rows, errors: [...res.errors, { row: 0, column: "", message: "file level" }], format: "xlsx" });
    expect(ext).toBe("xlsx");
    const again = await parseImportFile({ bytes, filename: "errors.xlsx" });
    expect(again.keys.at(-1)).toBe("errors");
    expect(again.rows.at(0)!.cells.errors).toBe("file level");
  });
});

describe("shipping columns (freight estimator)", () => {
  it("converts grams and centimetres to the catalogue's grams and millimetres", () => {
    const r = run({ unit_weight_g: "1,250", unit_length_cm: "30.5", unit_width_cm: "20", unit_height_cm: "12" });
    expect(r.errors).toEqual([]);
    expect(r.valid[0]!.shipping).toEqual({ unitWeightGrams: 1250, unitLengthMm: 305, unitWidthMm: 200, unitHeightMm: 120 });
  });
  it("leaves shipping undefined when the cells are blank", () => {
    expect(run({}).valid[0]!.shipping).toBeUndefined();
  });
  it.each([
    [{ unit_weight_g: "0" }, "unit_weight_g: Weight must be whole grams"],
    [{ unit_weight_g: "2.5" }, "unit_weight_g: Weight must be whole grams"],
    [{ unit_length_cm: "-1" }, "unit_length_cm: Size must be"],
    [{ unit_height_cm: "abc" }, "unit_height_cm: Size must be"],
  ])("rejects a bad cell (case %#)", (cells, msg) => {
    expect(msgs(run(cells)).join("|")).toContain(msg);
  });
});
