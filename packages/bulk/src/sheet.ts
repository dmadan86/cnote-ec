// Generic small-sheet reader (CSV / XLSX -> string matrix) for flows that are not the seller product import, e.g. a buyer's
// bill-of-materials upload on the RFQ form (docs/design/rfq-multiline.md). It reuses the import path's guards: format from magic
// bytes, UTF-8 / Windows-1252 / UTF-16LE decoding, delimiter detection, the xlsx zip-bomb pre-scan, and it never evaluates a formula
// (a formula cell yields its cached result, as text). Callers pass their own, much smaller, byte / row / column caps.
import { DomainError } from "@cnote/core";
import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { cellText, decodeText, detectDelimiter, detectFormat, guardXlsx } from "./parse";

export interface SheetLimits {
  /** reject files above this many bytes (before any decoding) */
  maxBytes: number;
  /** rows kept (header included); further rows are dropped and reported through `truncated` */
  maxRows: number;
  maxColumns: number;
}

export interface SheetMatrix {
  format: "csv" | "xlsx";
  /** every kept row, padded to the widest row, cells trimmed; the first non-empty row is the header row */
  rows: string[][];
  /** rows that were present in the file but dropped to respect `maxRows` */
  truncated: number;
}

const fail = (m: string): never => {
  throw new DomainError("validation", m);
};

/** Reads the first visible sheet of a .csv/.tsv/.txt/.xlsx file into a matrix. A zip or any other type is refused. */
export async function readSheetMatrix(bytes: Uint8Array, filename: string, limits: SheetLimits): Promise<SheetMatrix> {
  if (bytes.length === 0) fail("The file is empty.");
  if (bytes.length > limits.maxBytes) fail(`The file is larger than ${Math.max(1, Math.round(limits.maxBytes / 1048576))} MB.`);
  const format = detectFormat(bytes, filename);
  if (format === "zip") return fail("Upload a .csv or .xlsx file (not a zip).");
  let matrix: string[][];
  if (format === "csv") {
    const text = decodeText(bytes);
    try {
      matrix = parseCsv(text, { delimiter: detectDelimiter(text), relax_column_count: true, relax_quotes: true, skip_empty_lines: false, bom: true, trim: false }) as string[][];
    } catch (e) {
      return fail(`Could not read the CSV: ${(e as Error).message}`);
    }
  } else {
    guardXlsx(bytes, { maxTotalBytes: limits.maxBytes * 40, maxEntries: 200 });
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
    } catch {
      return fail("Could not read this Excel file. Save it as .xlsx and try again.");
    }
    const ws = wb.worksheets.find((s) => s.state !== "hidden") ?? wb.worksheets[0];
    if (!ws) return fail("The workbook has no sheets.");
    if (ws.columnCount > limits.maxColumns) fail(`The sheet has too many columns (limit ${limits.maxColumns}).`);
    if (ws.rowCount > limits.maxRows * 20 + 100) fail("The sheet has too many rows.");
    const width = ws.columnCount;
    matrix = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const line: string[] = [];
      for (let c = 1; c <= width; c++) line.push(cellText(row.getCell(c).value));
      matrix[n - 1] = line;
    });
    for (let i = 0; i < matrix.length; i++) matrix[i] ??= [];
  }
  const firstUsed = matrix.findIndex((r) => r.some((c) => String(c ?? "").trim() !== ""));
  if (firstUsed < 0) return fail("The file is empty.");
  const used = matrix.slice(firstUsed);
  const width = Math.max(...used.map((r) => r.length));
  if (width > limits.maxColumns) fail(`The file has too many columns (limit ${limits.maxColumns}).`);
  const trimmed = used.map((r) => Array.from({ length: width }, (_, i) => String(r[i] ?? "").trim()));
  // blank rows are dropped (a spreadsheet's trailing formatting leaves hundreds of them)
  const nonBlank = trimmed.filter((r) => r.some((c) => c !== ""));
  return { format, rows: nonBlank.slice(0, limits.maxRows), truncated: Math.max(0, nonBlank.length - limits.maxRows) };
}
