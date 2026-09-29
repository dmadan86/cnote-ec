import ExcelJS from "exceljs";
import { unzipSync, strFromU8 } from "fflate";
import { validateImage } from "@cnote/media";
import { describe, expect, it } from "vitest";
import { buildImportTemplate, buildStarterKit, parseImportFile } from "../src";
import { CATS } from "./fixtures";

async function load(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

describe("buildImportTemplate", () => {
  it("xlsx: Products, Instructions and Categories sheets with headers, freeze, dropdowns and notes", async () => {
    const wb = await load(await buildImportTemplate({ format: "xlsx", categories: CATS }));
    expect(wb.worksheets.map((s) => s.name)).toEqual(["Products", "Instructions", "Categories"]);
    const ws = wb.getWorksheet("Products")!;
    const headers = (ws.getRow(1).values as string[]).slice(1);
    expect(headers.slice(0, 12)).toEqual(["sku*", "title*", "category*", "description", "price_rupees", "price_unit", "moq", "moq_unit", "hsn", "language", "image_files", "image_urls"]);
    expect(headers).toContain("attr:gsm* (GSM, g/m2)");
    expect(headers).toContain("attr:material (Material)");
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(ws.getColumn(2).width).toBeGreaterThan(30);
    expect(ws.getRow(1).getCell(1).note).toBeTruthy();
    // dropdowns: category refers to the Categories sheet, language + select attribute are inline lists
    expect(ws.getCell("C2").dataValidation).toMatchObject({ type: "list", formulae: ["Categories!$A$2:$A$4"] });
    expect(ws.getCell("J2").dataValidation.formulae![0]).toContain("hi");
    const matCol = headers.indexOf("attr:material (Material)") + 1;
    expect(ws.getCell(2, matCol).dataValidation.formulae![0]).toContain("Kraft");
    // three EXAMPLE rows
    expect([2, 3, 4].map((r) => String(ws.getCell(r, 1).value))).toEqual(["EXAMPLE-BOX-001", "EXAMPLE-TSHIRT-001", "EXAMPLE-PIPE-001"]);
    expect(String(ws.getCell(2, 3).value)).toBe("packaging-boxes");
    const cats = wb.getWorksheet("Categories")!;
    expect(cats.rowCount).toBe(4); // header + 3 non-prohibited
  });

  it("re-parsing the untouched template yields no rows (examples are skipped) and one real row is picked up", async () => {
    const buf = await buildImportTemplate({ format: "xlsx", categories: CATS });
    await expect(parseImportFile({ bytes: buf, filename: "t.xlsx" })).rejects.toThrow(/No product rows/);
    const wb = await load(buf);
    const ws = wb.getWorksheet("Products")!;
    ws.getRow(5).getCell(1).value = "REAL-1";
    ws.getRow(5).getCell(2).value = "Real product";
    ws.getRow(5).getCell(3).value = "ms-pipes";
    const out = Buffer.from(await wb.xlsx.writeBuffer());
    const parsed = await parseImportFile({ bytes: out, filename: "t.xlsx" });
    expect(parsed.rows.map((r) => r.cells.sku)).toEqual(["REAL-1"]);
    expect(parsed.rows[0]!.row).toBe(5);
  });

  it("csv: same headers, BOM, example rows, parses back to nothing", async () => {
    const buf = await buildImportTemplate({ format: "csv", categories: CATS });
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = buf.toString("utf8");
    expect(text.split("\r\n")[0]).toContain("sku*,title*,category*");
    expect(text).toContain("EXAMPLE-BOX-001");
    await expect(parseImportFile({ bytes: buf, filename: "t.csv" })).rejects.toThrow(/No product rows/);
  });

  it("limits attribute columns to the chosen category and rejects unknown/prohibited ones", async () => {
    const wb = await load(await buildImportTemplate({ format: "xlsx", categorySlug: "cotton-tshirts", categories: CATS }));
    const headers = (wb.getWorksheet("Products")!.getRow(1).values as string[]).join("|");
    expect(headers).toContain("attr:fabric");
    expect(headers).not.toContain("attr:material");
    await expect(buildImportTemplate({ format: "csv", categorySlug: "nope", categories: CATS })).rejects.toThrow(/Unknown category/);
    await expect(buildImportTemplate({ format: "csv", categorySlug: "weapons", categories: CATS })).rejects.toThrow(/Unknown category/);
  });
});

describe("buildStarterKit", () => {
  it("zips xlsx + csv + README + a valid example image", async () => {
    const files = unzipSync(new Uint8Array(await buildStarterKit({ categories: CATS })));
    expect(Object.keys(files).sort()).toEqual(["README.txt", "images/example-box-1.png", "products.csv", "products.xlsx"]);
    expect(strFromU8(files["README.txt"]!)).toContain("images/");
    expect(validateImage(files["images/example-box-1.png"]!).mime).toBe("image/png");
  });
});
