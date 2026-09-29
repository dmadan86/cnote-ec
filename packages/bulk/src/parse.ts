import { DomainError } from "@cnote/core";
import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { unzipSync } from "fflate";
import { isExampleSku, normalizeHeader } from "./columns";
import { LIMITS, type FileFormat, type RawRow } from "./types";

export interface ParsedImage {
  /** path relative to the images folder, original case, e.g. "box-1.jpg" or "sub/box-2.png" */
  path: string;
  size: number;
  /** full entry name inside the zip (for lazy extraction) */
  entry: string;
  /** present only when parsed with { withImages: true } */
  bytes?: Uint8Array;
}

export interface ParsedImport {
  format: FileFormat;
  /** original header cells of the products sheet (for the error report) */
  headers: string[];
  /** normalised header per column, "" for blank */
  keys: string[];
  rows: RawRow[];
  images: ParsedImage[];
  warnings: string[];
  /** name of the products file inside a zip */
  sheetFile?: string;
}

const fail = (m: string): never => {
  throw new DomainError("validation", m);
};

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

/** Format from magic bytes + extension. Throws a validation error for anything else. */
export function detectFormat(bytes: Uint8Array, filename: string): FileFormat {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05) && (bytes[3] === 0x04 || bytes[3] === 0x06);
  if (isZip) {
    if (ext === "xlsx" || ext === "xlsm") return "xlsx";
    if (ext === "zip") return "zip";
    // extension missing/wrong: an OOXML workbook is a zip containing xl/workbook.xml
    let looksXlsx = false;
    try {
      unzipSync(bytes, { filter: (f) => ((looksXlsx ||= f.name === "xl/workbook.xml"), false) });
    } catch {
      /* fall through */
    }
    return looksXlsx ? "xlsx" : "zip";
  }
  if (ext === "csv" || ext === "txt" || ext === "tsv") return "csv";
  if (ext === "xlsx" || ext === "zip") return fail(`This file is not a valid ${ext.toUpperCase()} file`);
  return fail("Unsupported file. Upload a .csv, .xlsx or .zip file");
}

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) fail("UTF-16 big-endian files are not supported; save as CSV UTF-8");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes); // Excel "CSV" on Windows
  }
}

/** Comma, semicolon (EU/Indian Excel locales) or tab: whichever occurs most outside quotes in the header line. */
export function detectDelimiter(text: string): "," | ";" | "\t" {
  let inQuotes = false;
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && ch in counts) counts[ch]!++;
  }
  const best = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? [","])[0] as "," | ";" | "\t";
  return counts[best]! > 0 ? best : ",";
}

function fromMatrix(matrix: string[][], format: FileFormat): Omit<ParsedImport, "images" | "sheetFile"> {
  const headerIdx = matrix.findIndex((r) => r.some((c) => c.trim() !== ""));
  if (headerIdx < 0) return fail("The file is empty. Use the template and add your products below the header row");
  const headers = matrix[headerIdx]!.map((c) => c.trim());
  const keys = headers.map((h) => normalizeHeader(h));
  const warnings: string[] = [];
  if (!keys.includes("sku")) fail('Missing required column "sku". Download the template to see the expected headers');
  if (!keys.includes("title")) fail('Missing required column "title". Download the template to see the expected headers');
  if (!keys.includes("category")) fail('Missing required column "category". Download the template to see the expected headers');
  const seen = new Set<string>();
  keys.forEach((k, i) => {
    if (!k) return;
    if (seen.has(k)) fail(`Column "${headers[i]}" appears more than once`);
    seen.add(k);
  });

  const rows: RawRow[] = [];
  for (let i = headerIdx + 1; i < matrix.length; i++) {
    const cells: Record<string, string> = {};
    const line = matrix[i]!;
    let any = false;
    keys.forEach((k, c) => {
      if (!k) return;
      const v = (line[c] ?? "").trim();
      if (v) any = true;
      cells[k] = v;
    });
    if (!any) continue; // blank row
    if (isExampleSku(cells.sku ?? "")) continue; // template example rows
    rows.push({ row: i + 1, cells });
    if (rows.length > LIMITS.maxRows) fail(`Too many rows: at most ${LIMITS.maxRows.toLocaleString("en-IN")} products per file. Split the file and import in parts`);
  }
  if (!rows.length) fail("No product rows found. Rows whose SKU starts with EXAMPLE are skipped");
  return { format, headers, keys, rows, warnings };
}

export function parseCsvBytes(bytes: Uint8Array): Omit<ParsedImport, "images" | "sheetFile"> {
  if (bytes.length > LIMITS.maxSheetBytes) fail("CSV is larger than 50 MB");
  const text = decodeText(bytes);
  let matrix: string[][];
  try {
    matrix = parseCsv(text, { delimiter: detectDelimiter(text), relax_column_count: true, relax_quotes: true, skip_empty_lines: false, bom: true, trim: false }) as string[][];
  } catch (e) {
    return fail(`Could not read the CSV: ${(e as Error).message}`);
  }
  return fromMatrix(matrix, "csv");
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if ("result" in o) return cellText(o.result as ExcelJS.CellValue);
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join("");
    if (typeof o.text === "string") return o.text;
    if ("error" in o) return "";
  }
  return "";
}

export async function parseXlsxBytes(bytes: Uint8Array): Promise<Omit<ParsedImport, "images" | "sheetFile">> {
  if (bytes.length > LIMITS.maxSheetBytes) fail("Workbook is larger than 50 MB");
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  } catch {
    return fail("Could not read this Excel file. Save it as .xlsx and try again");
  }
  const ws = wb.getWorksheet("Products") ?? wb.worksheets.find((s) => s.state !== "hidden") ?? wb.worksheets[0];
  if (!ws) return fail("The workbook has no sheets");
  if (ws.rowCount > LIMITS.maxRows * 4 + 100) fail(`The sheet has too many rows (limit ${LIMITS.maxRows.toLocaleString("en-IN")} products)`);
  const width = ws.columnCount;
  const matrix: string[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const line: string[] = [];
    for (let c = 1; c <= width; c++) line.push(cellText(row.getCell(c).value));
    matrix[n - 1] = line;
  });
  for (let i = 0; i < matrix.length; i++) matrix[i] ??= [];
  return fromMatrix(matrix, "xlsx");
}

// ---------------------------------------------------------------------------------------------
// ZIP

const SHEET_RE = /^products\.(csv|xlsx)$/i;

/** Rejects zip-slip style names; returns the cleaned path or null for junk entries to ignore. */
export function safeZipPath(name: string): string | null {
  if (name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[a-z]:/i.test(name)) return fail(`Unsafe file path in the ZIP: "${name}"`);
  const parts = name.split("/").filter((p) => p !== "");
  if (parts.some((p) => p === ".." || p === ".")) return fail(`Unsafe file path in the ZIP: "${name}"`);
  if (!parts.length || name.endsWith("/")) return null; // directory
  if (parts[0] === "__MACOSX" || parts.some((p) => p.startsWith("."))) return null; // macOS / hidden junk
  return parts.join("/");
}

interface ZipInfo {
  entries: { name: string; path: string; size: number }[];
}

function listZip(bytes: Uint8Array): ZipInfo {
  if (bytes.length > LIMITS.maxZipCompressedBytes) fail("ZIP is larger than 200 MB");
  const entries: ZipInfo["entries"] = [];
  let total = 0;
  let count = 0;
  try {
    unzipSync(bytes, {
      filter: (f) => {
        if (++count > LIMITS.maxZipFiles + 500) fail(`The ZIP contains too many files (limit ${LIMITS.maxZipFiles.toLocaleString("en-IN")})`);
        const path = safeZipPath(f.name);
        if (path === null) return false;
        total += f.originalSize;
        if (total > LIMITS.maxZipUncompressedBytes) fail("The ZIP expands to more than 500 MB");
        entries.push({ name: f.name, path, size: f.originalSize });
        return false;
      },
    });
  } catch (e) {
    if (e instanceof DomainError) throw e;
    return fail("Could not read this ZIP file. Re-create it and try again");
  }
  if (entries.length > LIMITS.maxZipFiles) fail(`The ZIP contains too many files (limit ${LIMITS.maxZipFiles.toLocaleString("en-IN")})`);
  return { entries };
}

export async function parseZipBytes(bytes: Uint8Array, opts: { withImages?: boolean } = {}): Promise<ParsedImport> {
  const { entries } = listZip(bytes);
  const sheets = entries.filter((e) => {
    const parts = e.path.split("/");
    return parts.length <= 2 && SHEET_RE.test(parts[parts.length - 1]!);
  });
  if (sheets.length === 0) fail("The ZIP must contain one products.csv or products.xlsx (at the top level or inside one folder)");
  if (sheets.length > 1) fail(`The ZIP contains more than one products file (${sheets.map((s) => s.path).join(", ")}). Keep exactly one`);
  const sheet = sheets[0]!;
  const base = sheet.path.includes("/") ? sheet.path.slice(0, sheet.path.indexOf("/") + 1) : "";
  const imagesPrefix = `${base}images/`.toLowerCase();

  const imageEntries = entries.filter((e) => e.path.toLowerCase().startsWith(imagesPrefix) && IMAGE_EXT.test(e.path));
  const oversize = imageEntries.find((e) => e.size > LIMITS.maxImageBytes);
  if (oversize) fail(`Image "${oversize.path.slice(imagesPrefix.length)}" is larger than 5 MB`);

  const wanted = new Set([sheet.name, ...(opts.withImages ? imageEntries.map((e) => e.name) : [])]);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, { filter: (f) => wanted.has(f.name) });
  } catch {
    return fail("Could not read this ZIP file. Re-create it and try again");
  }
  const declared = new Map(entries.map((e) => [e.name, e.size]));
  for (const [n, data] of Object.entries(files)) if (data.length > (declared.get(n) ?? 0) + 1024) fail("The ZIP is corrupt or malicious (size mismatch)");

  const sheetBytes = files[sheet.name]!;
  const parsed = sheet.path.toLowerCase().endsWith(".xlsx") ? await parseXlsxBytes(sheetBytes) : parseCsvBytes(sheetBytes);
  const images: ParsedImage[] = imageEntries.map((e) => ({ path: e.path.slice(imagesPrefix.length), size: e.size, entry: e.name, bytes: files[e.name] }));
  return { ...parsed, format: "zip", images, sheetFile: sheet.path };
}

/** Detect the format and read the sheet (and, for ZIPs, the image inventory). */
export async function parseImportFile(input: { bytes: Uint8Array; filename: string }, opts: { withImages?: boolean } = {}): Promise<ParsedImport> {
  const format = detectFormat(input.bytes, input.filename);
  if (format === "zip") return parseZipBytes(input.bytes, opts);
  const parsed = format === "csv" ? parseCsvBytes(input.bytes) : await parseXlsxBytes(input.bytes);
  return { ...parsed, images: [] };
}

/** Extracts just these zip entries (used per import batch so memory stays bounded). Missing names are absent from the map. */
export function readZipEntries(bytes: Uint8Array, entries: string[]): Map<string, Uint8Array> {
  if (!entries.length) return new Map();
  const wanted = new Set(entries);
  const files = unzipSync(bytes, { filter: (f) => wanted.has(f.name) });
  return new Map(Object.entries(files));
}
