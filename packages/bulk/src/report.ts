import ExcelJS from "exceljs";
import { toCsv, workbookBuffer } from "./sheets";
import type { FileFormat, RawRow, RowError } from "./types";

const errorText = (errs: RowError[]) => errs.map((e) => (e.column ? `${e.column}: ${e.message}` : e.message)).join(" | ");

/**
 * Error report: the ORIGINAL columns of every row that has problems, plus an "errors" column (and "row" first),
 * so the seller can fix the rows and upload just this file again. CSV in -> CSV out, otherwise XLSX.
 */
export async function buildErrorReport(input: { headers: string[]; keys: string[]; rows: RawRow[]; errors: RowError[]; format: FileFormat }): Promise<{ bytes: Buffer; ext: "csv" | "xlsx" }> {
  const byRow = new Map<number, RowError[]>();
  for (const e of input.errors) byRow.set(e.row, [...(byRow.get(e.row) ?? []), e]);
  const fileLevel = byRow.get(0);
  const headers = ["row", ...input.headers.filter((h, i) => h && input.keys[i]), "errors"];
  const cols = input.keys.map((k, i) => ({ k, i })).filter((x) => x.k);
  const lines = input.rows
    .filter((r) => byRow.has(r.row))
    .map((r) => [r.row, ...cols.map(({ k }) => r.cells[k] ?? ""), errorText(byRow.get(r.row)!)]);
  // errors for rows we no longer hold (e.g. import-time) or whole-file problems
  const known = new Set(input.rows.map((r) => r.row));
  for (const [row, errs] of byRow) if (row !== 0 && !known.has(row)) lines.push([row, ...cols.map(() => ""), errorText(errs)]);
  if (fileLevel) lines.unshift([0, ...cols.map(() => ""), errorText(fileLevel)]);

  if (input.format === "csv") return { bytes: toCsv(headers, lines), ext: "csv" };
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Errors", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = headers.map((h, i) => ({ header: h, width: i === headers.length - 1 ? 80 : i === 0 ? 6 : 20 }));
  ws.getRow(1).font = { bold: true };
  for (const l of lines) ws.addRow(l);
  ws.getColumn(headers.length).font = { color: { argb: "FFB91C1C" } };
  return { bytes: await workbookBuffer(wb), ext: "xlsx" };
}
