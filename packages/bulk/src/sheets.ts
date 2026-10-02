import type { CategoryView } from "@cnote/catalogue";
import ExcelJS from "exceljs";
import { stringify } from "csv-stringify/sync";
import { neutraliseFormula } from "@cnote/security";
import { LANGUAGES, UNITS, type Column } from "./columns";
import { LIMITS } from "./types";

export type Cell = string | number | null | undefined;

/** UTF-8 with BOM + CRLF so Excel opens it correctly (Hindi etc.); our parser strips the BOM. */
export function toCsv(headers: string[], rows: Cell[][]): Buffer {
  const body = stringify([headers, ...rows.map((r) => r.map((c) => neutraliseFormula(c ?? "")))], { record_delimiter: "\r\n" });
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, "utf8")]);
}

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A5F" } };
const REQUIRED_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFB45309" } };
const EXAMPLE_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };

export interface ProductsSheetOptions {
  columns: Column[];
  rows: Cell[][];
  categories: CategoryView[];
  /** how many leading rows are examples (shaded grey) */
  exampleRows?: number;
  /** add dropdowns / hints (template) */
  guidance?: boolean;
}

/** Writes the "Products" sheet: header, frozen row, widths, notes, dropdowns. Column order == `columns`. */
export function addProductsSheet(wb: ExcelJS.Workbook, opts: ProductsSheetOptions): ExcelJS.Worksheet {
  const { columns, rows, categories } = opts;
  const ws = wb.addWorksheet("Products", { views: [{ state: "frozen", ySplit: 1, xSplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.height = 22;
  columns.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = c.required ? REQUIRED_FILL : HEADER_FILL;
    cell.alignment = { vertical: "middle", wrapText: true };
    if (opts.guidance !== false) cell.note = { texts: [{ text: c.hint }], margins: { insetmode: "custom", inset: [0.1, 0.1, 0.1, 0.1] } };
  });
  const idx = (k: string) => columns.findIndex((c) => c.key === k) + 1;
  for (const k of ["sku", "hsn"]) if (idx(k)) ws.getColumn(idx(k)).numFmt = "@"; // keep leading zeros
  rows.forEach((r, ri) => {
    const row = ws.addRow(columns.map((_, ci) => neutraliseFormula(r[ci] ?? null)));
    if (ri < (opts.exampleRows ?? 0)) row.eachCell({ includeEmpty: true }, (c) => void (c.fill = EXAMPLE_FILL));
  });

  if (opts.guidance !== false) {
    const last = LIMITS.maxRows + 1;
    const usable = categories.filter((c) => !c.prohibited);
    const addList = (key: string, list: string, strict = true) => {
      const col = idx(key);
      if (!col || list.length === 0) return;
      for (let r = 2; r <= last; r++) {
        ws.getCell(r, col).dataValidation = { type: "list", allowBlank: true, formulae: [list], showErrorMessage: strict, errorStyle: strict ? "stop" : "warning", errorTitle: "Not in list", error: "Pick a value from the list." };
      }
    };
    if (usable.length) addList("category", `Categories!$A$2:$A$${usable.length + 1}`);
    addList("price_unit", `"${UNITS.join(",")}"`, false);
    addList("moq_unit", `"${UNITS.join(",")}"`, false);
    addList("language", `"${LANGUAGES.join(",")}"`);
    // select attributes: dropdown only when every category defining the key agrees on the options
    const byKey = new Map<string, Set<string>>();
    for (const c of usable) for (const f of c.attributeSchema.fields) if (f.type === "select") byKey.set(f.key, new Set([...(byKey.get(f.key) ?? []), ...(f.options ?? [])]));
    for (const c of columns) {
      if (!c.key.startsWith("attr:")) continue;
      const opts2 = byKey.get(c.key.slice(5));
      const list = opts2 ? [...opts2].join(",") : "";
      if (opts2 && list.length <= 250 && ![...opts2].some((o) => o.includes(","))) addList(c.key, `"${list}"`);
    }
  }
  return ws;
}

export function addCategoriesSheet(wb: ExcelJS.Workbook, categories: CategoryView[]): void {
  const ws = wb.addWorksheet("Categories", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "slug (use in the category column)", key: "slug", width: 34 },
    { header: "name", key: "name", width: 30 },
    { header: "attributes (column: label, unit, type, options)", key: "attrs", width: 110 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const c of categories.filter((x) => !x.prohibited)) {
    const attrs = c.attributeSchema.fields
      .map((f) => `attr:${f.key}: ${f.label}${f.unit ? `, ${f.unit}` : ""}, ${f.type}${f.required ? ", required for review" : ""}${f.options?.length ? `, options: ${f.options.join(" | ")}` : ""}`)
      .join("\n");
    const row = ws.addRow({ slug: c.slug, name: c.name, attrs });
    row.alignment = { wrapText: true, vertical: "top" };
  }
}

export function addTextSheet(wb: ExcelJS.Workbook, name: string, lines: string[]): void {
  const ws = wb.addWorksheet(name);
  ws.columns = [{ width: 120 }];
  for (const l of lines) {
    const r = ws.addRow([l]);
    r.alignment = { wrapText: true, vertical: "top" };
    if (l && l === l.toUpperCase() && l.length > 3) r.font = { bold: true, size: 12 };
  }
}

export async function workbookBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const newWorkbook = (): ExcelJS.Workbook => {
  const wb = new ExcelJS.Workbook();
  wb.creator = "cnote";
  wb.created = new Date();
  return wb;
};
