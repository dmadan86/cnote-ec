import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { columnsFor } from "../src/columns";
import { parseCsvBytes } from "../src/parse";
import { addProductsSheet, newWorkbook, toCsv } from "../src/sheets";
import { CATS, csv, GOOD } from "./fixtures";

describe("spreadsheet formula injection in exports (security audit)", () => {
  const evil = ["=HYPERLINK(\"http://x\",\"c\")", "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"];

  it("toCsv prefixes a quote on text cells starting with = + - @ tab or CR, leaves numbers and normal text", () => {
    const body = toCsv(["a", "b"], [[...evil.slice(0, 2)], [...evil.slice(2, 4)], [...evil.slice(4)], [-5, "plain text"]]).toString("utf8");
    for (const e of evil) expect(body).not.toMatch(new RegExp(`(^|,|\\n)"?${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(body).toContain("'=HYPERLINK");
    expect(body).toContain("'+1+1");
    expect(body).toContain("'-2+3");
    expect(body).toContain("'@SUM(A1)");
    expect(body).toMatch(/-5,plain text/); // numbers stay numeric
  });

  it("the xlsx writer neutralises the same cells", async () => {
    const wb = newWorkbook();
    const columns = columnsFor(CATS).slice(0, 3);
    addProductsSheet(wb, { columns, rows: [["=cmd|' /C calc'!A0", "+x", "ok"]], categories: CATS, guidance: false });
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(buf as unknown as ArrayBuffer);
    const row = wb2.getWorksheet("Products")!.getRow(2);
    expect(row.getCell(1).value).toBe("'=cmd|' /C calc'!A0");
    expect(row.getCell(2).value).toBe("'+x");
    expect(row.getCell(3).value).toBe("ok");
  });

  it("re-importing our own export restores the original text", () => {
    const exported = toCsv(["sku*", "title*", "category*"], [["=A1", "-widget", "packaging-boxes"]]);
    const parsed = parseCsvBytes(exported);
    expect(parsed.rows[0]!.cells).toMatchObject({ sku: "=A1", title: "-widget" });
    expect(parseCsvBytes(csv(GOOD)).rows).toHaveLength(1);
  });
});
