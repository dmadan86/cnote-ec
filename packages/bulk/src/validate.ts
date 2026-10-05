import { SKU_RE, validateAttributes, validateStock, LANGS, type Availability, type CategoryView, type ListingView } from "@cnote/catalogue";
import { parseMoq, parseStockCells, rupeesToPaise } from "./cells";
import { BASE_KEYS, READONLY_KEYS, VARIANT_PREFIX } from "./columns";
import { isVariantRow, validateVariantRows } from "./variant-rows";
import { LIMITS, type ImportMode, type RawRow, type RowError } from "./types";

type Field = CategoryView["attributeSchema"]["fields"][number];

/** A row that passed validation, with typed values. `undefined` = cell was blank (leave unchanged on update). */
export interface ImportRow {
  row: number;
  sku: string;
  categoryId: string;
  categorySlug: string;
  title: string;
  description?: string;
  pricePaise?: number;
  priceUnit?: string;
  moq?: number;
  moqUnit?: string;
  hsn?: string;
  language?: string;
  /** sample workflow settings (docs/design/samples.md); undefined = cell blank (leave unchanged on update) */
  sampleAvailable?: boolean;
  samplePricePaise?: number;
  sampleMaxQty?: number;
  sampleDispatchDays?: number;
  sampleMinBuyerTier?: number;
  /** shipping facts per unit for the freight estimator (grams / millimetres); only the cells that were filled */
  shipping?: { unitWeightGrams?: number; unitLengthMm?: number; unitWidthMm?: number; unitHeightMm?: number };
  attributes: Record<string, string | number>;
  /** zip paths relative to images/ (original case) */
  imageFiles: string[];
  imageUrls: string[];
  /** stock columns; `undefined` = blank cell (leave unchanged on an existing listing) */
  availability?: Availability;
  availableQty?: number;
  leadTimeDays?: number;
  /** the complete variant set from the file's variant rows (replaces the listing's variants); absent = the file says nothing about variants */
  variants?: ImportVariant[];
  /** variant rows for an EXISTING listing with no product row in the file: only its variants are applied */
  variantsOnly?: boolean;
}

/** One validated variant row. Axis values are raw; the catalogue snaps them to the category's options on apply. */
export interface ImportVariant {
  row: number;
  sku: string;
  axisValues: Record<string, string>;
  pricePaise?: number;
  moq?: number;
  availability?: Availability;
  availableQty?: number;
  leadTimeDays?: number;
}

export interface ValidationContext {
  categories: CategoryView[];
  /** image paths available in the ZIP (relative to images/); empty for csv/xlsx */
  zipImages: string[];
  isZip: boolean;
  mode: ImportMode;
  submitForReview: boolean;
  /** the seller's existing listings by SKU (for create/upsert checks) */
  existing: Map<string, Pick<ListingView, "id" | "status">>;
  /** header keys present in the file (to warn about ignored columns) */
  fileKeys?: string[];
  /** category id of existing listings by SKU: needed for variant rows of a listing that has no product row in the file */
  existingCategoryBySku?: Map<string, string>;
}

export interface ValidationResult {
  valid: ImportRow[];
  errors: RowError[];
  warnings: string[];
  invalidRows: Set<number>;
}

const attrKeyNorm = (k: string) => k.trim().toLowerCase().replace(/\s+/g, "_");

export { rupeesToPaise };

const splitList = (s: string) => s.split(/[,\n;|]/).map((x) => x.trim()).filter(Boolean);

/** Resolves an image reference (as typed in image_files) to a path inside images/. */
export function resolveImage(ref: string, zipImages: string[]): { path: string } | { error: string } {
  const clean = ref.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^images\//i, "");
  const lower = clean.toLowerCase();
  const exact = zipImages.find((p) => p.toLowerCase() === lower);
  if (exact) return { path: exact };
  if (!clean.includes("/")) {
    const byName = zipImages.filter((p) => p.toLowerCase().split("/").pop() === lower);
    if (byName.length === 1) return { path: byName[0]! };
    if (byName.length > 1) return { error: `Image "${ref}" is ambiguous: found in ${byName.length} folders; use the full path` };
  }
  return { error: `Image "${ref}" was not found in the ZIP's images/ folder` };
}

export function validateRows(rows: RawRow[], ctx: ValidationContext): ValidationResult {
  const productRows = rows.filter((r) => !isVariantRow(r));
  const variantRows = rows.filter(isVariantRow);
  const res = validateProductRows(productRows, ctx);
  if (variantRows.length) {
    validateVariantRows(variantRows, ctx, res, new Set(productRows.map((r) => r.cells.sku ?? "")));
    res.errors.sort((a, b) => a.row - b.row);
  }
  return res;
}

function validateProductRows(rows: RawRow[], ctx: ValidationContext): ValidationResult {
  const errors: RowError[] = [];
  const valid: ImportRow[] = [];
  const invalidRows = new Set<number>();
  const warnings: string[] = [];
  const bySlug = new Map(ctx.categories.map((c) => [c.slug.toLowerCase(), c]));
  const byName = new Map(ctx.categories.map((c) => [c.name.toLowerCase(), c]));
  const firstRowOfSku = new Map<string, number>();

  for (const k of ctx.fileKeys ?? []) {
    if (k && !BASE_KEYS.has(k) && !READONLY_KEYS.has(k) && !k.startsWith("attr:") && !k.startsWith(VARIANT_PREFIX)) warnings.push(`Column "${k}" is not recognised and was ignored`);
  }

  for (const r of rows) {
    const errs: RowError[] = [];
    const bad = (column: string, message: string) => errs.push({ row: r.row, column, message });
    const c = r.cells;

    // sku
    const sku = c.sku ?? "";
    if (!sku) bad("sku", "SKU is required");
    else if (!SKU_RE.test(sku)) bad("sku", "SKU may only contain letters, digits, . _ - (max 64 characters)");
    else {
      const first = firstRowOfSku.get(sku);
      if (first !== undefined) bad("sku", `Duplicate SKU "${sku}" (also on row ${first})`);
      else firstRowOfSku.set(sku, r.row);
      const ex = ctx.existing.get(sku);
      if (ex && ctx.mode === "create") bad("sku", `SKU "${sku}" already exists. Switch to "update by SKU" to change it`);
      else if (ex?.status === "archived") bad("sku", `SKU "${sku}" belongs to an archived listing and cannot be edited`);
    }

    // title
    const title = c.title ?? "";
    if (title.length < 3 || title.length > 200) bad("title", "Title must be 3-200 characters");

    // category
    const catRaw = c.category ?? "";
    const category = catRaw ? (bySlug.get(catRaw.toLowerCase()) ?? byName.get(catRaw.toLowerCase())) : undefined;
    if (!catRaw) bad("category", "Category is required");
    else if (!category) bad("category", `Unknown category "${catRaw}". Use a slug from the Categories sheet`);
    else if (category.prohibited) bad("category", `Category "${category.name}" is not permitted on the marketplace`);

    // description
    const description = c.description || undefined;
    if (description && description.length > 5000) bad("description", "Description is longer than 5000 characters");
    if (ctx.submitForReview && (description ?? "").length < 10 && !ctx.existing.has(sku)) bad("description", "Description must be at least 10 characters to submit for review");

    // price / moq
    let pricePaise: number | undefined;
    if (c.price_rupees) {
      const p = rupeesToPaise(c.price_rupees);
      if (p === null) bad("price_rupees", "Price must be an amount in rupees with at most 2 decimals, e.g. 12.50");
      else pricePaise = p;
    }
    let moq: number | undefined;
    if (c.moq) moq = parseMoq(c.moq, bad);
    for (const col of ["price_unit", "moq_unit"] as const) if ((c[col] ?? "").length > 30) bad(col, "Unit is longer than 30 characters");

    // stock
    const stock = parseStockCells(c, bad);
    if (stock.availability) {
      // an existing listing may already carry a lead time; the catalogue re-checks it on apply
      const lead = stock.leadTimeDays ?? (ctx.existing.has(sku) ? 0 : null);
      for (const m of validateStock({ availability: stock.availability, availableQty: stock.availableQty ?? null, leadTimeDays: lead })) bad("availability", m);
    } else if (stock.availableQty === 0) {
      bad("available_qty", "Quantity 0 needs availability out_of_stock");
    }

    // hsn
    let hsn: string | undefined;
    if (c.hsn) {
      if (!/^\d{4,8}$/.test(c.hsn)) bad("hsn", "HSN must be 4 to 8 digits");
      else hsn = c.hsn;
    }

    // language
    let language: string | undefined;
    if (c.language) {
      const l = c.language.toLowerCase();
      if (!(LANGS as readonly string[]).includes(l)) bad("language", `Language must be one of: ${LANGS.join(", ")}`);
      else language = l;
    }

    // samples
    let sampleAvailable: boolean | undefined;
    if (c.sample_available) {
      const v = c.sample_available.toLowerCase();
      if (["yes", "y", "true", "1"].includes(v)) sampleAvailable = true;
      else if (["no", "n", "false", "0"].includes(v)) sampleAvailable = false;
      else bad("sample_available", "sample_available must be yes or no");
    }
    let samplePricePaise: number | undefined;
    if (c.sample_price_rupees) {
      const p = rupeesToPaise(c.sample_price_rupees);
      if (p === null) bad("sample_price_rupees", "Sample price must be an amount in rupees with at most 2 decimals, e.g. 150 (0 = free)");
      else samplePricePaise = p;
    }
    const wholeIn = (col: string, min: number, max: number, label: string): number | undefined => {
      const raw = c[col];
      if (!raw) return undefined;
      const n = Number(raw.replace(/,/g, ""));
      if (!Number.isInteger(n) || n < min || n > max) {
        bad(col, `${label} must be a whole number from ${min} to ${max}`);
        return undefined;
      }
      return n;
    };
    const sampleMaxQty = wholeIn("sample_max_qty", 1, 1_000_000, "Sample max quantity");
    const sampleDispatchDays = wholeIn("sample_dispatch_days", 0, 90, "Sample dispatch days");
    const sampleMinBuyerTier = wholeIn("sample_min_buyer_tier", 0, 3, "Sample minimum buyer tier");
    if (sampleAvailable !== true && [samplePricePaise, sampleMaxQty, sampleDispatchDays, sampleMinBuyerTier].some((x) => x !== undefined) && !errs.some((e) => e.column === "sample_available")) {
      if (sampleAvailable === false) warnings.push(`Row ${r.row}: sample_ details are ignored because sample_available is no`);
      else if (!ctx.existing.has(sku)) bad("sample_available", "Set sample_available to yes to use the other sample_ columns");
    }

    // shipping facts (freight estimator)
    const shipping: NonNullable<ImportRow["shipping"]> = {};
    if (c.unit_weight_g) {
      const n = Number(c.unit_weight_g.replace(/,/g, ""));
      if (!Number.isInteger(n) || n < 1 || n > 50_000_000) bad("unit_weight_g", "Weight must be whole grams, 1 or more");
      else shipping.unitWeightGrams = n;
    }
    for (const [col, key] of [["unit_length_cm", "unitLengthMm"], ["unit_width_cm", "unitWidthMm"], ["unit_height_cm", "unitHeightMm"]] as const) {
      const raw = c[col];
      if (!raw) continue;
      const n = Number(raw.replace(/,/g, ""));
      if (!Number.isFinite(n) || n <= 0 || n > 2000) bad(col, "Size must be a number of centimetres between 0.1 and 2000");
      else shipping[key] = Math.max(1, Math.round(n * 10));
    }

    // attributes
    const attributes: Record<string, string | number> = {};
    if (category) {
      const fields = new Map<string, Field>(category.attributeSchema.fields.map((f) => [attrKeyNorm(f.key), f]));
      for (const [k, v] of Object.entries(c)) {
        if (!k.startsWith("attr:") || v === "") continue;
        const f = fields.get(attrKeyNorm(k.slice(5)));
        if (!f) {
          bad(k, `"${k.slice(5)}" is not an attribute of category "${category.name}"`);
          continue;
        }
        if (f.type === "number") {
          const n = Number(v.replace(/,/g, ""));
          if (!Number.isFinite(n)) bad(k, `${f.label} must be a number`);
          else attributes[f.key] = n;
        } else if (f.type === "select") {
          const opt = (f.options ?? []).find((o) => o.toLowerCase() === v.toLowerCase());
          if (!opt) bad(k, `${f.label} must be one of: ${(f.options ?? []).join(", ")}`);
          else attributes[f.key] = opt;
        } else if (v.length > 500) bad(k, `${f.label} is longer than 500 characters`);
        else attributes[f.key] = v;
      }
      // Required attributes matter when the listing is submitted for review. For an existing listing the stored
      // values may already satisfy them, so only brand-new SKUs are checked here (the submit step re-checks).
      if (ctx.submitForReview && !ctx.existing.has(sku) && !errs.some((e) => e.column.startsWith("attr:"))) {
        for (const p of validateAttributes(category.attributeSchema, attributes)) bad("attributes", p);
      }
    }

    // images
    const imageFiles: string[] = [];
    if (c.image_files) {
      const refs = splitList(c.image_files);
      if (!ctx.isZip) bad("image_files", "image_files needs a ZIP upload that contains the images. Upload a ZIP or use image_urls");
      else if (refs.length > LIMITS.maxImagesPerRow) bad("image_files", `At most ${LIMITS.maxImagesPerRow} images per product`);
      else {
        for (const ref of refs) {
          const res = resolveImage(ref, ctx.zipImages);
          if ("error" in res) bad("image_files", res.error);
          else if (!imageFiles.includes(res.path)) imageFiles.push(res.path);
        }
      }
    }
    const imageUrls: string[] = [];
    if (c.image_urls) {
      for (const u of splitList(c.image_urls)) {
        let ok = false;
        try {
          ok = new URL(u).protocol === "https:" && u.length <= 2000;
        } catch {
          /* invalid */
        }
        if (!ok) bad("image_urls", `"${u.slice(0, 60)}" is not a valid https:// link`);
        else imageUrls.push(u);
      }
      if (imageUrls.length > 10) bad("image_urls", "At most 10 image links per product");
    }

    if (errs.length) {
      errors.push(...errs);
      invalidRows.add(r.row);
      continue;
    }
    valid.push({
      row: r.row, sku, categoryId: category!.id, categorySlug: category!.slug, title, description, pricePaise, priceUnit: c.price_unit || undefined,
      moq, moqUnit: c.moq_unit || undefined, hsn, language, sampleAvailable, samplePricePaise, sampleMaxQty, sampleDispatchDays, sampleMinBuyerTier, shipping: Object.keys(shipping).length ? shipping : undefined, attributes, imageFiles, imageUrls,
      ...stock,
    });
  }
  return { valid, errors, warnings, invalidRows };
}
