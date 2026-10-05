import type { CategoryView } from "@cnote/catalogue";

/** Import/export column layout. Export is written in exactly this layout so a download can be edited and re-imported. */
export interface Column {
  /** normalised key used by the parser, e.g. "sku", "price_rupees", "attr:gsm" */
  key: string;
  /** header text as written in the template / export */
  header: string;
  required: boolean;
  width: number;
  hint: string;
}

export const UNITS = ["piece", "kg", "gram", "tonne", "meter", "feet", "sq ft", "sq meter", "litre", "box", "carton", "set", "pair", "dozen", "roll", "bag"];
export const LANGUAGES = ["en", "hi", "kn", "ta", "te", "mr", "gu", "bn"];

export const BASE_COLUMNS: Column[] = [
  { key: "sku", header: "sku*", required: true, width: 20, hint: "Your own product code. Letters, digits, . _ - only (max 64). It is the key used to update the listing on re-import. Rows whose SKU starts with EXAMPLE are skipped." },
  { key: "title", header: "title*", required: true, width: 44, hint: "Product name, 3-200 characters." },
  { key: "category", header: "category*", required: true, width: 22, hint: "Category slug from the Categories sheet (pick from the list)." },
  { key: "description", header: "description", required: false, width: 60, hint: "What it is, materials, sizes, uses. At least 10 characters if you submit for review (max 5000)." },
  { key: "price_rupees", header: "price_rupees", required: false, width: 14, hint: "Price in rupees per price_unit, e.g. 12.50. Leave empty for 'ask for price'." },
  { key: "price_unit", header: "price_unit", required: false, width: 12, hint: "Unit the price is for, e.g. piece, kg, meter." },
  { key: "moq", header: "moq", required: false, width: 8, hint: "Minimum order quantity, whole number, 1 or more." },
  { key: "moq_unit", header: "moq_unit", required: false, width: 12, hint: "Unit of the minimum order quantity." },
  { key: "hsn", header: "hsn", required: false, width: 10, hint: "HSN code, 4 to 8 digits (text; keep leading zeros)." },
  { key: "language", header: "language", required: false, width: 10, hint: "Language of title and description: en, hi, kn, ta, te, mr, gu, bn. Default en." },
  { key: "image_files", header: "image_files", required: false, width: 30, hint: "ZIP uploads only: comma-separated image file names inside the images/ folder, e.g. box-1.jpg, box-2.jpg (max 8)." },
  { key: "image_urls", header: "image_urls", required: false, width: 30, hint: "Optional https:// image links, comma-separated. Kept as reference images; uploaded files (image_files) go through staff approval." },
  { key: "unit_weight_g", header: "unit_weight_g", required: false, width: 14, hint: "Packed weight of ONE price unit in whole grams. Used for buyers' freight estimates." },
  { key: "unit_length_cm", header: "unit_length_cm", required: false, width: 14, hint: "Outer pack length of one unit in cm (decimals allowed). Freight estimates use length x width x height." },
  { key: "unit_width_cm", header: "unit_width_cm", required: false, width: 14, hint: "Outer pack width of one unit in cm." },
  { key: "unit_height_cm", header: "unit_height_cm", required: false, width: 14, hint: "Outer pack height of one unit in cm." },
];

/** Columns written after the editable ones on export only. Ignored on import. */
export const READONLY_COLUMNS = [
  { key: "status", header: "status (read-only)" },
  { key: "review_state", header: "review_state (read-only)" },
  { key: "live_version", header: "live_version (read-only)" },
] as const;
export const READONLY_KEYS: ReadonlySet<string> = new Set(READONLY_COLUMNS.map((c) => c.key));
export const BASE_KEYS: ReadonlySet<string> = new Set(BASE_COLUMNS.map((c) => c.key));

type Field = CategoryView["attributeSchema"]["fields"][number];

export function attrColumn(f: Field): Column {
  const label = f.unit ? `${f.label}, ${f.unit}` : f.label;
  const hint = [`${f.label}${f.unit ? ` (${f.unit})` : ""}`, f.type === "select" ? `one of: ${(f.options ?? []).join(", ")}` : f.type === "number" ? "a number" : "text", f.required ? "required when you submit for review" : "optional"].join(" - ");
  return { key: `attr:${f.key}`, header: `attr:${f.key}${f.required ? "*" : ""} (${label})`, required: false, width: 16, hint };
}

/** Attribute columns for the given categories (union by key, first definition wins). */
export function attributeColumns(categories: Pick<CategoryView, "attributeSchema">[]): Column[] {
  const seen = new Map<string, Field>();
  for (const c of categories) for (const f of c.attributeSchema.fields) if (!seen.has(f.key)) seen.set(f.key, f);
  return [...seen.values()].map(attrColumn);
}

export const columnsFor = (categories: Pick<CategoryView, "attributeSchema">[]): Column[] => [...BASE_COLUMNS, ...attributeColumns(categories)];

/**
 * Header text -> normalised key. Case/space-insensitive; drops "*" and "(...)" annotations, so
 * "Attr:GSM* (GSM, g/m2)" -> "attr:gsm" and "Price Rupees" -> "price_rupees".
 */
export function normalizeHeader(raw: string): string {
  let h = raw.replace(/^﻿/, "").replace(/\([^)]*\)/g, "").replace(/\*/g, "").trim().toLowerCase();
  if (h.startsWith("attr")) {
    const m = /^attr\s*:\s*(.+)$/.exec(h);
    if (m) return `attr:${m[1]!.trim().replace(/\s+/g, "_")}`;
  }
  h = h.replace(/[\s-]+/g, "_");
  if (h === "category_slug") return "category";
  return h;
}

export const isExampleSku = (sku: string): boolean => /^example([-_.\s]|$)/i.test(sku.trim());
