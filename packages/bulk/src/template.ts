import { DomainError } from "@cnote/core";
import { listCategories, type CategoryView } from "@cnote/catalogue";
import { deflateSync } from "node:zlib";
import { zipSync, strToU8 } from "fflate";
import { columnsFor, type Column } from "./columns";
import { addCategoriesSheet, addProductsSheet, addTextSheet, newWorkbook, toCsv, workbookBuffer, type Cell } from "./sheets";
import { LIMITS } from "./types";

interface Example {
  sku: string;
  title: string;
  match: RegExp;
  description: string;
  price: string;
  priceUnit: string;
  moq: string;
  moqUnit: string;
  hsn: string;
  attrs: Record<string, string | number>;
  files: string;
}

const EXAMPLES: Example[] = [
  {
    sku: "EXAMPLE-BOX-001", title: "Corrugated shipping box 12x9x6 in, 5-ply", match: /pack|box|carton|paper/i,
    description: "5-ply corrugated box, 300 GSM kraft liner, suitable for e-commerce and export shipping. Custom printing available.",
    price: "18.50", priceUnit: "piece", moq: "500", moqUnit: "piece", hsn: "48191010", attrs: { gsm: 300, material: "Kraft", plies: 5 }, files: "example-box-1.png",
  },
  {
    sku: "EXAMPLE-TSHIRT-001", title: "Men's round-neck cotton T-shirt, 180 GSM", match: /cloth|apparel|garment|textile|fabric|shirt/i,
    description: "100% combed cotton, 180 GSM, pre-shrunk, available in S to XXL and 12 colours. Bulk printing and private label on request.",
    price: "145", priceUnit: "piece", moq: "100", moqUnit: "piece", hsn: "61091000", attrs: { gsm: 180, material: "Cotton", fabric: "Cotton" }, files: "",
  },
  {
    sku: "EXAMPLE-PIPE-001", title: "MS ERW round pipe 2 inch, IS 1239", match: /pipe|steel|metal|hardware|industrial|iron/i,
    description: "Mild steel ERW round pipe, 2 inch nominal bore, 6 metre length, conforming to IS 1239. Mill test certificate provided.",
    price: "84000", priceUnit: "tonne", moq: "5", moqUnit: "tonne", hsn: "73063090", attrs: { grade: "IS 1239", material: "Mild steel", length: 6 }, files: "",
  },
];

function exampleRows(columns: Column[], categories: CategoryView[]): Cell[][] {
  const usable = categories.filter((c) => !c.prohibited);
  if (!usable.length) return [];
  return EXAMPLES.map((e, i) => {
    const cat = usable.find((c) => e.match.test(`${c.slug} ${c.name}`)) ?? usable[i % usable.length]!;
    const fieldByKey = new Map(cat.attributeSchema.fields.map((f) => [f.key.toLowerCase(), f]));
    const values: Record<string, Cell> = {
      sku: e.sku, title: e.title, category: cat.slug, description: e.description, price_rupees: e.price, price_unit: e.priceUnit, moq: e.moq,
      moq_unit: e.moqUnit, hsn: e.hsn, language: "en", image_files: e.files, image_urls: "",
    };
    for (const [k, v] of Object.entries(e.attrs)) {
      const f = fieldByKey.get(k.toLowerCase());
      if (!f) continue;
      if (f.type === "select") values[`attr:${f.key}`] = f.options?.find((o) => o.toLowerCase() === String(v).toLowerCase()) ?? f.options?.[0] ?? "";
      else if (f.type === "number") values[`attr:${f.key}`] = typeof v === "number" ? v : "";
      else values[`attr:${f.key}`] = String(v);
    }
    // any select attribute still empty: use its first option so the example shows a legal value
    for (const f of cat.attributeSchema.fields) if (f.type === "select" && !values[`attr:${f.key}`] && f.options?.length) values[`attr:${f.key}`] = f.options[0]!;
    return columns.map((c) => values[c.key] ?? "");
  });
}

const INSTRUCTIONS = [
  "HOW TO BULK IMPORT PRODUCTS",
  "1. Fill the Products sheet, one product per row, below the header row. The three grey EXAMPLE rows are skipped automatically (any SKU starting with EXAMPLE is ignored); delete or keep them.",
  "2. Save, then upload the file under Listings > Import. You can also upload a ZIP that contains this file plus your product photos.",
  "3. We check every row first (a dry run) and show you each problem with its row and column. Nothing is imported until you confirm.",
  "",
  "REQUIRED COLUMNS",
  "sku - your own product code. Letters, digits, . _ - only, up to 64 characters, unique in the file. Columns marked with * in the header are required.",
  "title - 3 to 200 characters.  category - the slug from the Categories sheet.",
  "",
  "OPTIONAL COLUMNS",
  "description (max 5000; at least 10 characters if you submit for review), price_rupees (e.g. 12.50; empty = ask for price), price_unit, moq (whole number >= 1), moq_unit, hsn (4-8 digits), language (en, hi, kn, ta, te, mr, gu, bn; default en).",
  "sample_available (yes/no), sample_price_rupees (0 = free), sample_max_qty, sample_dispatch_days, sample_min_buyer_tier (0-3): let buyers request a sample before a bulk order. Empty cells leave the current setting unchanged.",
  "availability (in_stock, made_to_order, out_of_stock), available_qty (units on hand) and lead_time_days (required for made_to_order) set the stock of a product. On a product that is already live they take effect at once, without review.",
  "attr:<name> columns are the attributes of a category (for example attr:gsm). Fill them only for products in that category; see the Categories sheet for the list, units and allowed options.",
  "",
  "VARIANTS (size, colour ...)",
  "Variant axes are set per category (the variant:<axis> columns). Add one row per variant directly below its product: put the PRODUCT's sku in sku, your variant code in variant_sku, a value in every variant:<axis> column, and optionally price_rupees, moq, availability, available_qty, lead_time_days (they apply to the variant). All other columns on a variant row are ignored.",
  "The variant rows of a product are its complete variant set: variants you leave out are removed. Up to 100 variants per product. A change to variants (like any content change) goes through review before buyers see it; stock changes do not. Quantity price tiers and variant photos are kept as they are; edit them in the listing editor.",
  "",
  "IMAGES",
  "image_files: comma-separated names of photos inside the images/ folder of your ZIP, for example box-1.jpg, box-2.jpg. JPEG, PNG or WebP, 200 to 6000 px, up to 5 MB each, up to 8 per product.",
  "image_urls: optional https:// links kept as reference images.",
  "unit_weight_g (whole grams), unit_length_cm, unit_width_cm, unit_height_cm: packed weight and outer size of ONE price unit; buyers see freight estimates from these. Optional.",
  "Uploaded photos go through the same staff approval as photos added one by one. They appear on your live listing only after they are approved.",
  "",
  "ZIP LAYOUT",
  "my-products.zip -> products.xlsx (or products.csv) at the top, and an images/ folder with your photos. Exactly one products file. Limits: 200 MB zip, 500 MB unzipped, 2,000 files, 5 MB per image.",
  "",
  "CREATE OR UPDATE",
  "Create new only: rows whose SKU already exists are reported as errors.  Update by SKU (upsert): existing SKUs are updated, new SKUs are created. Empty cells on an existing product are left unchanged.",
  "Imports edit your working copy. Choose 'submit for review' to send each product for review at the same time; nothing goes live without the usual automated checks and, where needed, staff review.",
  "",
  "LIMITS",
  `Up to ${LIMITS.maxRows.toLocaleString("en-IN")} products per file, ${LIMITS.importsPerHour} imports per hour, one import at a time. Files are kept ${LIMITS.retentionDays} days and then deleted.`,
  "",
  "CSV FILES",
  "CSV works too (comma or semicolon separated, UTF-8). Use the same column headers. Keep leading zeros in hsn by formatting the column as text.",
];

const README = `cnote bulk import starter kit
=============================

Files
  products.xlsx   Excel template: Products sheet with dropdowns and hints, an Instructions sheet and a Categories sheet.
  products.csv    The same columns as plain CSV (opens in Excel, Google Sheets, LibreOffice).
  images/         Example photo. Put your own product photos here.

How to use
  1. Open products.xlsx (or products.csv) and replace the three EXAMPLE rows with your products.
     Rows whose sku starts with EXAMPLE are skipped on import.
  2. In image_files write the photo file names, comma-separated, e.g.  box-1.jpg, box-2.jpg
  3. Zip products.xlsx (or products.csv) together with the images/ folder. Keep products.* at the top level.
  4. Upload the zip in Listings > Import. You will see a dry-run report with any problems before anything is imported.

Limits
  Up to ${LIMITS.maxRows} products per file. Zip: 200 MB, 500 MB unzipped, 2,000 files, 5 MB per image.
  Photos: JPEG, PNG or WebP, at least 200x200 px. Photos are approved by our staff before buyers see them.

Update later
  Use Listings > Export to download your catalogue in this same layout, edit it and import it again with
  "update by SKU" selected. Listings are matched by their sku.
`;

async function resolveCategories(categorySlug?: string, injected?: CategoryView[]): Promise<{ all: CategoryView[]; chosen: CategoryView[] }> {
  const all = injected ?? (await listCategories());
  if (!categorySlug) return { all, chosen: all.filter((c) => !c.prohibited) };
  const one = all.find((c) => c.slug === categorySlug && !c.prohibited);
  if (!one) throw new DomainError("validation", `Unknown category "${categorySlug}"`, undefined, "bulk.unknownCategory", { categorySlug });
  return { all, chosen: [one] };
}

export interface TemplateOptions {
  format: "xlsx" | "csv";
  /** limit attribute columns (and examples) to one category */
  categorySlug?: string;
  /** tests: skip the DB lookup */
  categories?: CategoryView[];
}

export async function buildImportTemplate(opts: TemplateOptions): Promise<Buffer> {
  const { all, chosen } = await resolveCategories(opts.categorySlug, opts.categories);
  const columns = columnsFor(chosen);
  const rows = exampleRows(columns, chosen);
  if (opts.format === "csv") return toCsv(columns.map((c) => c.header), rows);
  const wb = newWorkbook();
  // Categories sheet is added after Products but Products validations reference it by name
  addProductsSheet(wb, { columns, rows, categories: opts.categorySlug ? chosen : all, exampleRows: rows.length });
  addTextSheet(wb, "Instructions", INSTRUCTIONS);
  addCategoriesSheet(wb, opts.categorySlug ? chosen : all);
  return workbookBuffer(wb);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

/** A valid 400x300 PNG (passes the 200 px minimum), soft blue with a lighter band; ~1 KB. No image dependency. */
export function placeholderPng(width = 400, height = 300): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (width * 3 + 1);
    raw[o] = 0;
    const band = y > height / 3 && y < (2 * height) / 3;
    for (let x = 0; x < width; x++) {
      raw[o + 1 + x * 3] = band ? 190 : 150;
      raw[o + 2 + x * 3] = band ? 210 : 180;
      raw[o + 3 + x * 3] = band ? 235 : 215;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** ZIP with products.xlsx, products.csv, README.txt and an example image, ready to edit and re-upload. */
export async function buildStarterKit(opts: { categorySlug?: string; categories?: CategoryView[] } = {}): Promise<Buffer> {
  const [xlsx, csv] = await Promise.all([
    buildImportTemplate({ format: "xlsx", ...opts }),
    buildImportTemplate({ format: "csv", ...opts }),
  ]);
  return Buffer.from(
    zipSync({
      "products.xlsx": new Uint8Array(xlsx),
      "products.csv": new Uint8Array(csv),
      "README.txt": strToU8(README),
      "images/example-box-1.png": new Uint8Array(placeholderPng()),
    }),
  );
}
