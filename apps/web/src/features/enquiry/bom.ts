// Bill-of-materials helpers for the RFQ form (docs/design/rfq-multiline.md). Pure and framework-free: shared by the upload route
// (server) and the editor (client). The server (createEnquiry) re-validates every line; nothing here is trusted.

export const MAX_BOM_LINES = 50;
export const BOM_FIELDS = ["itemName", "spec", "quantity", "unit", "targetPrice", "hsn", "category"] as const;
export type BomField = (typeof BOM_FIELDS)[number];
export const REQUIRED_BOM_FIELDS: BomField[] = ["itemName", "quantity"];

/** One editable row. Numbers stay strings while typing; `key` is a stable React key. */
export interface BomRow {
  key: string;
  itemName: string;
  spec: string;
  quantity: string;
  unit: string;
  /** rupees per unit, optional */
  targetPrice: string;
  hsn: string;
  categorySlug: string;
}

export type BomMapping = Record<BomField, number | null>;

const SYNONYMS: Record<BomField, string[]> = {
  itemName: ["item", "item name", "itemname", "name", "product", "product name", "description", "material", "part", "part name", "particulars", "items"],
  spec: ["spec", "specification", "specifications", "notes", "note", "remarks", "details", "grade", "size", "make"],
  quantity: ["quantity", "qty", "qty.", "nos", "no of units", "required quantity", "order quantity"],
  unit: ["unit", "uom", "units", "unit of measure", "unit of measurement"],
  targetPrice: ["target price", "target", "price", "rate", "unit price", "target rate", "budget", "target price inr per unit", "target price per unit"],
  hsn: ["hsn", "hsn code", "hsn sac", "hs code"],
  category: ["category", "type", "product category"],
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[(\[].*?[)\]]/g, " ") // "Target price (INR per unit)" -> "target price"
    .replace(/[*_:\-./]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Best-effort column detection from the header row; first match per field wins and a column is used once. */
export function detectMapping(headers: string[]): BomMapping {
  const mapping = Object.fromEntries(BOM_FIELDS.map((f) => [f, null])) as BomMapping;
  const used = new Set<number>();
  const cols = headers.map(norm);
  // exact synonym first, then "starts with" (e.g. "quantity required")
  for (const pass of [0, 1]) {
    for (const f of BOM_FIELDS) {
      if (mapping[f] !== null) continue;
      const idx = cols.findIndex((c, i) => !used.has(i) && c !== "" && SYNONYMS[f].some((s) => (pass === 0 ? c === s : c.startsWith(`${s} `))));
      if (idx >= 0) { mapping[f] = idx; used.add(idx); }
    }
  }
  return mapping;
}

/**
 * Text pulled from a spreadsheet is never executed here, but it is also written to our database and may be exported again by someone
 * else. A leading = + @ TAB CR is stripped, and a leading "-" is stripped unless it starts a number ("-5 mm"); the export helpers still
 * neutralise on the way out (defence in depth). Control characters are removed.
 */
export function sanitizeCell(v: string, max = 1000): string {
  let s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  s = s.replace(/^[=+@\t\r]+/, "");
  while (/^-/.test(s) && !/^-\s*[\d.]/.test(s)) s = s.slice(1);
  return s.trim().slice(0, max);
}

const UNIT_ALIASES: Record<string, string> = {
  piece: "pcs", pieces: "pcs", pc: "pcs", nos: "pcs", no: "pcs", number: "pcs", numbers: "pcs", each: "pcs", unit: "pcs", units: "pcs",
  kgs: "kg", kilogram: "kg", kilograms: "kg", tons: "ton", tonne: "ton", tonnes: "ton", mt: "ton", meters: "meter", metre: "meter", metres: "meter", mtr: "meter", m: "meter",
  sets: "set", boxes: "box", litres: "litre", liter: "litre", liters: "litre", ltr: "litre", l: "litre",
};
export const normaliseUnit = (raw: string): string => {
  const k = sanitizeCell(raw, 20).toLowerCase();
  if (!k) return "pcs";
  return UNIT_ALIASES[k] ?? k.slice(0, 20);
};

const newKey = () => `r${Math.random().toString(36).slice(2, 10)}`;
export const emptyRow = (): BomRow => ({ key: newKey(), itemName: "", spec: "", quantity: "", unit: "pcs", targetPrice: "", hsn: "", categorySlug: "" });

export interface BomImportResult {
  rows: BomRow[];
  /** 1-based spreadsheet row numbers that were skipped, with the reason key (translated by the UI) */
  skipped: { row: number; reason: "noItem" | "badQuantity" | "unknownCategory" }[];
  /** data rows beyond MAX_BOM_LINES that were not imported */
  clipped: number;
}

const parseQty = (s: string): number | null => {
  const t = s.replace(/[,\s]/g, "");
  if (!/^\d+(\.0+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= 1 && n <= 2_000_000_000 ? n : null;
};

/** Applies a column mapping to the data rows (everything after the header). `firstRowNumber` is the spreadsheet row number of data[0]. */
export function applyMapping(data: string[][], mapping: BomMapping, categories: { slug: string; name: string }[], firstRowNumber = 2, room = MAX_BOM_LINES): BomImportResult {
  const get = (r: string[], f: BomField) => (mapping[f] === null ? "" : (r[mapping[f]!] ?? ""));
  const bySlug = new Map(categories.flatMap((c) => [[c.slug.toLowerCase(), c.slug], [c.name.toLowerCase(), c.slug]] as const));
  const rows: BomRow[] = [];
  const skipped: BomImportResult["skipped"] = [];
  let clipped = 0;
  data.forEach((r, i) => {
    if (r.every((c) => c.trim() === "")) return;
    const rowNo = firstRowNumber + i;
    const itemName = sanitizeCell(get(r, "itemName"), 140);
    if (!itemName) return void skipped.push({ row: rowNo, reason: "noItem" });
    const qty = parseQty(get(r, "quantity"));
    if (qty === null) return void skipped.push({ row: rowNo, reason: "badQuantity" });
    if (rows.length >= room) { clipped++; return; }
    const catRaw = sanitizeCell(get(r, "category"), 100).toLowerCase();
    const slug = catRaw ? bySlug.get(catRaw) : undefined;
    if (catRaw && !slug) skipped.push({ row: rowNo, reason: "unknownCategory" }); // imported without a category; the row is flagged
    const price = sanitizeCell(get(r, "targetPrice"), 20).replace(/[₹,\s]|rs\.?|inr/gi, "");
    rows.push({
      key: newKey(),
      itemName,
      spec: sanitizeCell(get(r, "spec"), 1000),
      quantity: String(qty),
      unit: normaliseUnit(get(r, "unit")),
      targetPrice: /^\d+(\.\d{1,2})?$/.test(price) ? price : "",
      hsn: sanitizeCell(get(r, "hsn"), 40).replace(/\D/g, "").slice(0, 8),
      categorySlug: slug ?? "",
    });
  });
  return { rows, skipped, clipped };
}

export type BomRowError = { field: "itemName" | "quantity" | "unit" | "targetPrice" | "hsn"; code: "required" | "quantity" | "price" | "hsn" };

/** Per-row validation shown inline (the server re-validates). Fully blank rows are errors only if they are the sole row. */
export function validateRow(r: BomRow): BomRowError[] {
  const errs: BomRowError[] = [];
  if (!r.itemName.trim()) errs.push({ field: "itemName", code: "required" });
  if (parseQty(r.quantity.trim()) === null) errs.push({ field: "quantity", code: "quantity" });
  if (!r.unit.trim()) errs.push({ field: "unit", code: "required" });
  if (r.targetPrice.trim() && !/^\d+(\.\d{1,2})?$/.test(r.targetPrice.trim())) errs.push({ field: "targetPrice", code: "price" });
  if (r.hsn.trim() && !/^\d{4}(\d{2}(\d{2})?)?$/.test(r.hsn.trim())) errs.push({ field: "hsn", code: "hsn" });
  return errs;
}

/** Payload for createEnquiry({ lines }). Rupees become integer paise. */
export function rowsToLines(rows: BomRow[]) {
  return rows.map((r) => ({
    itemName: r.itemName.trim(),
    spec: r.spec.trim() || null,
    quantity: parseQty(r.quantity.trim()) ?? 0,
    unit: r.unit.trim(),
    targetPricePaise: r.targetPrice.trim() ? Math.round(Number(r.targetPrice) * 100) : null,
    categorySlug: r.categorySlug || null,
    hsn: r.hsn.trim() || null,
  }));
}

/** Move helper: returns a new array with the item at `from` moved to `to` (clamped). */
export function moveRow<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return list;
  const t = Math.max(0, Math.min(list.length - 1, to));
  if (t === from) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(t, 0, item!);
  return next;
}

/** Reads the `lines` JSON field of the RFQ form (set by the editor). Absent = a one-item RFQ. The server re-validates every line. */
export function linesFromForm(f: FormData): ReturnType<typeof rowsToLines> | undefined {
  const raw = f.get("lines");
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  if (raw.length > 300_000) throw new Error("Too many lines.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Could not read the item lines. Please reload the page and try again.");
  }
  return Array.isArray(parsed) ? (parsed as ReturnType<typeof rowsToLines>) : undefined;
}

/** The template buyers can download (served by GET /api/rfq/bom). */
export const BOM_TEMPLATE_CSV =
  "Item name,Specification,Quantity,Unit,Target price (INR per unit),HSN,Category\r\n" +
  "M8 hex bolt,SS304 40 mm,500,pcs,12.50,73181500,\r\n" +
  "Flat washer M8,Zinc plated,1000,pcs,,73182200,\r\n";
