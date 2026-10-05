// Pure helpers for the stock + variants UI (no server imports: unit-testable). docs/design/variants-stock.md
import { rupeesToPaise } from "@cnote/core";
import type { Availability, SellerVariantView, VariantAxis, VariantInput } from "@cnote/catalogue";

export const MAX_VARIANT_ROWS = 100;
export const MAX_VARIANT_TIERS = 8;
export const AVAILABILITY_OPTIONS: readonly Availability[] = ["in_stock", "made_to_order", "out_of_stock"];

/** One variant row as the editor holds it (everything is a string while typing). */
export interface VariantRow {
  /** React key; also the stable identity of rows that have no server id yet */
  key: string;
  id?: string;
  sku: string;
  axes: Record<string, string>;
  priceRupees: string;
  moq: string;
  tiers: { minQty: string; price: string }[];
  availability: Availability;
  qty: string;
  leadTime: string;
  imageId: string;
}

/** The JSON the editor posts (key is dropped). */
export type VariantPayload = Omit<VariantRow, "key">;

export type VariantRowError = { n: number; code: "sku" | "axis" | "number" | "price" | "tier"; axis?: string };

const blank = (s: string) => s.trim() === "";
const whole = (s: string, min: number): number | null | "bad" => {
  if (blank(s)) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= min ? n : "bad";
};

/** Converts the editor payload to catalogue input (rupees -> paise once). Errors carry the 1-based row number for the UI to word. */
export function parseVariantRows(rows: readonly VariantPayload[], axes: readonly VariantAxis[]): { variants: VariantInput[]; errors: VariantRowError[] } {
  const errors: VariantRowError[] = [];
  const variants: VariantInput[] = [];
  rows.forEach((r, i) => {
    const n = i + 1;
    if (blank(r.sku)) errors.push({ n, code: "sku" });
    const axisValues: Record<string, string> = {};
    for (const a of axes) {
      const v = (r.axes[a.key] ?? "").trim();
      if (!v) errors.push({ n, code: "axis", axis: a.label });
      else axisValues[a.key] = v;
    }
    const moq = whole(r.moq, 1);
    const qty = whole(r.qty, 0);
    const lead = whole(r.leadTime, 0);
    if (moq === "bad" || qty === "bad" || lead === "bad") errors.push({ n, code: "number" });
    let pricePaise: number | null = null;
    if (!blank(r.priceRupees)) {
      const p = Number(r.priceRupees);
      if (!Number.isFinite(p) || p < 0) errors.push({ n, code: "price" });
      else pricePaise = rupeesToPaise(p);
    }
    const priceTiers: { minQty: number; pricePaise: number }[] = [];
    for (const t of r.tiers) {
      if (blank(t.minQty) && blank(t.price)) continue;
      const q = Number(t.minQty);
      const p = Number(t.price);
      if (blank(t.minQty) || blank(t.price) || !Number.isInteger(q) || q < 1 || !Number.isFinite(p) || p < 0) errors.push({ n, code: "tier" });
      else priceTiers.push({ minQty: q, pricePaise: rupeesToPaise(p) });
    }
    variants.push({
      ...(r.id ? { id: r.id } : {}),
      sku: r.sku.trim(),
      axisValues,
      pricePaise,
      priceTiers,
      moq: typeof moq === "number" ? moq : null,
      availability: r.availability,
      // an out-of-stock variant cannot hold quantity: the number is dropped rather than refused
      availableQty: r.availability === "out_of_stock" ? null : typeof qty === "number" ? qty : null,
      leadTimeDays: typeof lead === "number" ? lead : null,
      imageId: r.imageId || null,
    });
  });
  return { variants, errors };
}

/** Rows from the server's variants (rupees as plain numbers, no trailing zeros). */
export function rowsFromVariants(variants: readonly SellerVariantView[]): VariantRow[] {
  return variants.map((v) => ({
    key: v.id,
    id: v.id,
    sku: v.sku,
    axes: { ...v.axisValues },
    priceRupees: v.pricePaise === null ? "" : String(v.pricePaise / 100),
    moq: v.moq === null ? "" : String(v.moq),
    tiers: v.priceTiers.map((t) => ({ minQty: String(t.minQty), price: String(t.pricePaise / 100) })),
    availability: v.availability,
    qty: v.availableQty === null ? "" : String(v.availableQty),
    leadTime: v.leadTimeDays === null ? "" : String(v.leadTimeDays),
    imageId: v.imageId ?? "",
  }));
}

const comboKey = (axes: readonly VariantAxis[], values: Record<string, string>) => axes.map((a) => (values[a.key] ?? "").toLowerCase()).join("\u0000");

/**
 * Every combination of the axes' option lists that is not already a row, up to `room` rows. Axes without a closed option list
 * cannot be enumerated, so those cells stay empty for the seller to type. Returns [] when no axis has options.
 */
export function missingCombinations(axes: readonly VariantAxis[], existing: readonly Record<string, string>[], room: number): Record<string, string>[] {
  if (!axes.some((a) => a.options?.length)) return [];
  let combos: Record<string, string>[] = [{}];
  for (const a of axes) {
    if (!a.options?.length) continue;
    combos = combos.flatMap((c) => a.options!.map((o) => ({ ...c, [a.key]: o })));
  }
  const have = new Set(existing.map((e) => comboKey(axes, e)));
  return combos.filter((c) => !have.has(comboKey(axes, c))).slice(0, Math.max(0, room));
}

/** SKU suggestion for a generated row: BASE-M-RED (letters and digits only, upper case). */
export function suggestSku(base: string, axes: readonly VariantAxis[], values: Record<string, string>): string {
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "");
  const parts = axes.map((a) => clean(values[a.key] ?? "")).filter(Boolean);
  return [clean(base) || "VAR", ...parts].join("-").slice(0, 64);
}

/** Lead time needed? A made-to-order state without a lead time cannot be applied. */
export function needsLeadTime(availability: Availability, leadTime: number | null | undefined): boolean {
  return availability === "made_to_order" && (leadTime === null || leadTime === undefined);
}
