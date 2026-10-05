import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { readSheetMatrix } from "../src/sheet";

const LIMITS = { maxBytes: 1024 * 1024, maxRows: 5, maxColumns: 10 };
const bytes = (s: string) => new TextEncoder().encode(s);

describe("readSheetMatrix (generic small sheets, e.g. an RFQ bill of materials)", () => {
  it("reads CSV with comma, semicolon and tab delimiters, quoted cells and a BOM; trims and drops blank rows", async () => {
    const csv = '﻿Item; Qty ;Notes\n"Bolt, M8";100;"say ""hi"""\n;;\n\nNut;50;\n';
    const m = await readSheetMatrix(bytes(csv), "bom.csv", LIMITS);
    expect(m.format).toBe("csv");
    expect(m.rows).toEqual([["Item", "Qty", "Notes"], ["Bolt, M8", "100", 'say "hi"'], ["Nut", "50", ""]]);
    expect(m.truncated).toBe(0);
    expect((await readSheetMatrix(bytes("a\tb\n1\t2"), "x.tsv", LIMITS)).rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("reads xlsx (first visible sheet), turns formulas into their cached result text and never evaluates them", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("BOM");
    ws.addRow(["Item", "Qty", "Rate"]);
    ws.addRow(["Washer", 10, { formula: "1+1", result: 2 }]);
    ws.addRow(["=HYPERLINK(\"http://x\")", 3, 4.5]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const m = await readSheetMatrix(new Uint8Array(buf), "bom.xlsx", LIMITS);
    expect(m.format).toBe("xlsx");
    expect(m.rows).toEqual([["Item", "Qty", "Rate"], ["Washer", "10", "2"], ['=HYPERLINK("http://x")', "3", "4.5"]]); // text stays text; callers neutralise it
  });

  it("caps rows (reporting how many were dropped), columns and bytes; refuses zips and unknown types", async () => {
    const many = ["h", ...Array.from({ length: 9 }, (_, i) => `r${i}`)].join("\n");
    const m = await readSheetMatrix(bytes(many), "a.csv", LIMITS);
    expect(m.rows).toHaveLength(5);
    expect(m.truncated).toBe(5);
    await expect(readSheetMatrix(bytes(Array.from({ length: 11 }, (_, i) => i).join(",")), "a.csv", LIMITS)).rejects.toThrow(/too many columns/);
    await expect(readSheetMatrix(bytes("a,b\n1,2"), "a.csv", { ...LIMITS, maxBytes: 3 })).rejects.toThrow(/larger than/);
    await expect(readSheetMatrix(new Uint8Array(), "a.csv", LIMITS)).rejects.toThrow(/empty/);
    await expect(readSheetMatrix(bytes("MZ not a sheet"), "evil.exe", LIMITS)).rejects.toThrow(/Unsupported/);
    await expect(readSheetMatrix(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]), "a.zip", LIMITS)).rejects.toThrow(/not a zip/);
    await expect(readSheetMatrix(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]), "a.xlsx", LIMITS)).rejects.toThrow();
    await expect(readSheetMatrix(bytes(" , \n ,"), "a.csv", LIMITS)).rejects.toThrow(/empty/);
  });
});
