import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { detectDelimiter, detectFormat, parseImportFile } from "../src/parse";
import { LIMITS } from "../src";
import { csv, GOOD, HEADER, png, zip } from "./fixtures";

const parse = (bytes: Uint8Array, filename: string) => parseImportFile({ bytes, filename });

describe("csv", () => {
  it("parses rows with 1-based spreadsheet row numbers, normalised headers, skipping blank and EXAMPLE rows", async () => {
    const p = await parse(csv("EXAMPLE-1,x,ms-pipes", ",,,", GOOD, "", 'BOX-2,"Title, with comma",ms-pipes,"multi\nline"'), "p.csv");
    expect(p.format).toBe("csv");
    expect(p.rows.map((r) => [r.row, r.cells.sku])).toEqual([[4, "BOX-1"], [6, "BOX-2"]]);
    expect(p.rows[1]!.cells).toMatchObject({ title: "Title, with comma", description: "multi\nline" });
    expect(p.keys).toContain("attr:gsm");
  });
  it("handles a UTF-8 BOM", async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), csv(GOOD)]);
    const p = await parse(withBom, "p.csv");
    expect(p.keys[0]).toBe("sku");
    expect(p.rows).toHaveLength(1);
  });
  it("detects semicolon and tab delimiters, ignoring delimiters inside quotes", async () => {
    const semi = Buffer.from(`${HEADER.replaceAll(",", ";")}\n${GOOD.replaceAll(",", ";")}`);
    expect((await parse(semi, "p.csv")).rows[0]!.cells.price_rupees).toBe("18.50");
    expect(detectDelimiter('a,"b;c;d",e\n')).toBe(",");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
    expect(detectDelimiter("single")).toBe(",");
  });
  it("decodes Windows-1252 and UTF-16LE files", async () => {
    const latin = Buffer.concat([Buffer.from(`${HEADER}\nS1,`), Buffer.from([0x43, 0x61, 0x66, 0xe9]), Buffer.from(",ms-pipes")]);
    expect((await parse(latin, "p.csv")).rows[0]!.cells.title).toBe("Café");
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${HEADER}\nS1,हिंदी शीर्षक,ms-pipes`, "utf16le")]);
    expect((await parse(u16, "p.csv")).rows[0]!.cells.title).toBe("हिंदी शीर्षक");
  });
  it("rejects missing required columns, duplicate columns, empty files and too many rows", async () => {
    await expect(parse(Buffer.from("title,category\nx,y"), "p.csv")).rejects.toThrow(/Missing required column "sku"/);
    await expect(parse(Buffer.from("sku,sku,title,category\na,b,c,d"), "p.csv")).rejects.toThrow(/more than once/);
    await expect(parse(Buffer.from("\n\n"), "p.csv")).rejects.toThrow(/empty/);
    await expect(parse(csv("EXAMPLE-1,x,y"), "p.csv")).rejects.toThrow(/No product rows/);
    const many = Array.from({ length: LIMITS.maxRows + 1 }, (_, i) => `S${i},Title ${i},ms-pipes`);
    await expect(parse(csv(...many), "p.csv")).rejects.toThrow(/Too many rows/);
    const ok = Array.from({ length: LIMITS.maxRows }, (_, i) => `S${i},Title ${i},ms-pipes`);
    expect((await parse(csv(...ok), "p.csv")).rows).toHaveLength(LIMITS.maxRows);
  });
  it("reports unknown columns as ignored via keys and accepts header variants", async () => {
    const p = await parse(Buffer.from("SKU *,Title,Category,Price Rupees,Attr: GSM (GSM),Whatever\nA1,Some title,ms-pipes,5,120,z"), "p.csv");
    expect(p.keys).toEqual(["sku", "title", "category", "price_rupees", "attr:gsm", "whatever"]);
  });
});

describe("xlsx", () => {
  it("reads the Products sheet, numbers, formulas and rich text as text", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Products");
    ws.addRow(["sku*", "title*", "category*", "price_rupees", "moq", "description"]);
    ws.addRow(["A-1", "Box", "ms-pipes", 12.5, 100, { richText: [{ text: "Hello " }, { text: "world" }] }]);
    ws.addRow(["A-2", "Box 2", "ms-pipes", { formula: "5*2", result: 10 }, null, null]);
    const p = await parseImportFile({ bytes: new Uint8Array(await wb.xlsx.writeBuffer()), filename: "x.xlsx" });
    expect(p.rows[0]!.cells).toMatchObject({ price_rupees: "12.5", moq: "100", description: "Hello world" });
    expect(p.rows[1]!.cells.price_rupees).toBe("10");
    expect(p.rows.map((r) => r.row)).toEqual([2, 3]);
  });
  it("falls back to the first sheet when there is no Products sheet; EXAMPLE rows skipped", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    [["sku", "title", "category"], ["EXAMPLE-1", "x", "y"], ["Z1", "Zed", "ms-pipes"]].forEach((r) => ws.addRow(r));
    const p = await parseImportFile({ bytes: new Uint8Array(await wb.xlsx.writeBuffer()), filename: "x.xlsx" });
    expect(p.rows.map((r) => r.cells.sku)).toEqual(["Z1"]);
  });
  it("rejects corrupt workbooks", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]);
    await expect(parse(bytes, "x.xlsx")).rejects.toThrow();
  });
});

describe("format detection", () => {
  it("uses magic bytes and extension", async () => {
    const z = zip({ "products.csv": csv(GOOD).toString() });
    expect(detectFormat(z, "a.zip")).toBe("zip");
    expect(detectFormat(z, "a")).toBe("zip");
    expect(detectFormat(Buffer.from("a,b"), "a.csv")).toBe("csv");
    expect(() => detectFormat(Buffer.from("junk"), "a.pdf")).toThrow(/Unsupported/);
    expect(() => detectFormat(Buffer.from("not a zip"), "a.zip")).toThrow(/not a valid ZIP/);
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Products").addRow(["sku"]);
    expect(detectFormat(new Uint8Array(await wb.xlsx.writeBuffer()), "no-extension")).toBe("xlsx");
  });
});

describe("zip", () => {
  it("reads products.csv + images/, ignoring macOS junk", async () => {
    const z = zip({ "products.csv": csv(GOOD.replace(",,,300", ",box-1.jpg,,300")), "images/box-1.jpg": png(), "__MACOSX/._x": "junk", ".DS_Store": "x" });
    const p = await parseImportFile({ bytes: z, filename: "kit.zip" }, { withImages: true });
    expect(p.format).toBe("zip");
    expect(p.images.map((i) => i.path)).toEqual(["box-1.jpg"]);
    expect(p.images[0]!.bytes!.length).toBeGreaterThan(50);
    expect(p.rows).toHaveLength(1);
    const lazy = await parseImportFile({ bytes: z, filename: "kit.zip" });
    expect(lazy.images[0]!.bytes).toBeUndefined();
  });
  it("accepts a single wrapping folder", async () => {
    const p = await parse(zip({ "batch/products.csv": csv(GOOD), "batch/images/a.png": png() }), "k.zip");
    expect(p.sheetFile).toBe("batch/products.csv");
    expect(p.images.map((i) => i.path)).toEqual(["a.png"]);
  });
  it("blocks zip-slip and unsafe paths", async () => {
    for (const bad of ["../evil.txt", "images/../../evil.png", "/abs/evil.png", "C:/evil.png", "images\\..\\evil.png"]) {
      await expect(parse(zip({ "products.csv": csv(GOOD), [bad]: "x" }), "k.zip")).rejects.toThrow(/Unsafe file path/);
    }
  });
  it("requires exactly one products file", async () => {
    await expect(parse(zip({ "images/a.png": png() }), "k.zip")).rejects.toThrow(/must contain one products/);
    await expect(parse(zip({ "products.csv": csv(GOOD), "products.xlsx": "x" }), "k.zip")).rejects.toThrow(/more than one products file/);
    await expect(parse(zip({ "a/b/products.csv": csv(GOOD) }), "k.zip")).rejects.toThrow(/must contain one products/);
  });
  it("enforces size and count limits", async () => {
    await expect(parse(zip({ "products.csv": csv(GOOD), "images/big.jpg": new Uint8Array(LIMITS.maxImageBytes + 1) }), "k.zip")).rejects.toThrow(/larger than 5 MB/);
    const many: Record<string, string> = { "products.csv": csv(GOOD).toString() };
    for (let i = 0; i <= LIMITS.maxZipFiles; i++) many[`images/i${i}.png`] = "x";
    await expect(parse(zip(many), "k.zip")).rejects.toThrow(/too many files/);
    await expect(parse(new Uint8Array(LIMITS.maxZipCompressedBytes + 1).fill(0).map((_, i) => (i < 4 ? [0x50, 0x4b, 3, 4][i]! : 0)), "k.zip")).rejects.toThrow(/200 MB/);
  });
  it("rejects a corrupt zip", async () => {
    await expect(parse(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9, 9, 9, 9, 9, 9]), "k.zip")).rejects.toThrow(/Could not read this ZIP/);
  });
});
