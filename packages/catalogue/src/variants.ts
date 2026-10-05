// Product variants (docs/design/variants-stock.md). Pure types, schemas and validation.
//
// Variant AXES (size, colour, grade, material ...) are DATA: they live in `Category.attributeSchema.variantAxes`, edited like
// any other category config, so no vertical is hardcoded (ADR-011). A listing has 0..MAX_VARIANTS variants; each carries its own
// SKU, a value for every axis of the category, optional price / quantity-tier / MOQ overrides and its own stock state.
import { z } from "zod";
import { availabilitySchema, validateStock, type Availability } from "./availability";
import { MAX_TIERS, parsePriceTiers, priceTierSchema, validatePriceTiers, type PriceTier } from "./tiers";

export const MAX_VARIANTS = 100;
export const MAX_AXES = 4;
import { SKU_RE } from "./validate";
export const AXIS_KEY_RE = /^[a-z][a-z0-9_]{0,29}$/;
export const MAX_AXIS_VALUE_LENGTH = 60;

/** One variant axis as configured on a category. `options` (when present) is a closed list; otherwise values are free text. */
export interface VariantAxis {
  key: string;
  label: string;
  options?: string[];
}

export const variantAxisSchema = z.object({
  key: z.string().regex(AXIS_KEY_RE),
  label: z.string().trim().min(1).max(60),
  options: z.array(z.string().trim().min(1).max(MAX_AXIS_VALUE_LENGTH)).min(1).max(100).optional(),
});

/** The axes of a category's attributeSchema; malformed entries are dropped, at most MAX_AXES kept. */
export function categoryAxes(schema: { variantAxes?: unknown } | null | undefined): VariantAxis[] {
  const raw = schema?.variantAxes;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: VariantAxis[] = [];
  for (const r of raw) {
    const p = variantAxisSchema.safeParse(r);
    if (!p.success || seen.has(p.data.key)) continue;
    seen.add(p.data.key);
    out.push({ key: p.data.key, label: p.data.label, ...(p.data.options ? { options: p.data.options } : {}) });
    if (out.length >= MAX_AXES) break;
  }
  return out;
}

/** Seller input for one variant. `id` (or a matching `sku`) keeps the identity of an existing variant across edits. */
export const variantInputSchema = z.object({
  id: z.uuid().optional(),
  sku: z.string().trim().regex(SKU_RE, "Variant SKU may contain letters, digits, . _ - (max 64)"),
  axisValues: z.record(z.string().max(30), z.string().trim().min(1).max(MAX_AXIS_VALUE_LENGTH)),
  pricePaise: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  priceTiers: z.array(priceTierSchema).max(MAX_TIERS).optional(),
  moq: z.number().int().min(1).max(2_000_000_000).nullable().optional(),
  availability: availabilitySchema.optional(),
  availableQty: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  leadTimeDays: z.number().int().min(0).max(730).nullable().optional(),
  imageId: z.uuid().nullable().optional(),
});
export type VariantInput = z.infer<typeof variantInputSchema>;

/** A variant as read back (working copy, snapshot and LIVE). `id` is stable across versions. */
export interface VariantView {
  id: string;
  sku: string;
  axisValues: Record<string, string>;
  pricePaise: number | null;
  priceTiers: PriceTier[];
  moq: number | null;
  availability: Availability;
  availableQty: number | null;
  leadTimeDays: number | null;
  imageId: string | null;
  sortOrder: number;
}

/** Variant with the time its stock was last set (authoring/seller views only). */
export interface SellerVariantView extends VariantView {
  stockUpdatedAt: string | null;
}

const viewSchema = z.object({
  id: z.string(),
  sku: z.string(),
  axisValues: z.record(z.string(), z.string()),
  pricePaise: z.number().nullable().optional(),
  priceTiers: z.unknown().optional(),
  moq: z.number().nullable().optional(),
  availability: availabilitySchema.optional(),
  availableQty: z.number().nullable().optional(),
  leadTimeDays: z.number().nullable().optional(),
  imageId: z.string().nullable().optional(),
  sortOrder: z.number().optional(),
});

/** Reads stored JSON (snapshot / LIVE) back into variants, dropping malformed rows. */
export function parseVariants(raw: unknown): VariantView[] {
  if (!Array.isArray(raw)) return [];
  const out: VariantView[] = [];
  raw.forEach((r, i) => {
    const p = viewSchema.safeParse(r);
    if (!p.success) return;
    const v = p.data;
    out.push({
      id: v.id,
      sku: v.sku,
      axisValues: v.axisValues,
      pricePaise: v.pricePaise ?? null,
      priceTiers: parsePriceTiers(v.priceTiers),
      moq: v.moq ?? null,
      availability: v.availability ?? "in_stock",
      availableQty: v.availableQty ?? null,
      leadTimeDays: v.leadTimeDays ?? null,
      imageId: v.imageId ?? null,
      sortOrder: v.sortOrder ?? i,
    });
  });
  return out;
}

/** `{ key, label }` axes frozen into a snapshot / LIVE row (options are not needed once values are chosen). */
export function parseAxes(raw: unknown): VariantAxis[] {
  return categoryAxes({ variantAxes: raw });
}

/** Lower-cased "axis:value" pairs: the keys of the variant facet and filter. */
export function variantValueKeys(variants: readonly Pick<VariantView, "axisValues">[]): string[] {
  const set = new Set<string>();
  for (const v of variants) for (const [k, val] of Object.entries(v.axisValues)) set.add(`${k}:${val}`.toLowerCase());
  return [...set].sort();
}

/** Splits a facet key back into its axis and (lower-cased) value. */
export function splitVariantKey(key: string): { axis: string; value: string } | null {
  const i = key.indexOf(":");
  return i > 0 && i < key.length - 1 ? { axis: key.slice(0, i), value: key.slice(i + 1) } : null;
}

export interface VariantContext {
  /** the listing's MOQ: variant tiers must start at or above the variant's own MOQ, else the listing's */
  listingMoq: number | null;
  /** the listing's lead time (days): a made-to-order variant without its own lead time uses it */
  listingLeadTimeDays: number | null;
}

export interface NormalisedVariant {
  id?: string;
  sku: string;
  axisValues: Record<string, string>;
  pricePaise: number | null;
  priceTiers: PriceTier[];
  moq: number | null;
  availability: Availability;
  availableQty: number | null;
  leadTimeDays: number | null;
  imageId: string | null;
}

/**
 * Validates a complete variant set against the category's axes and returns the canonical form (axis values snapped to the
 * configured options case-insensitively). The problems list is empty when the set is valid.
 *  - a category with no axes cannot have variants;
 *  - every variant sets every axis, and only axes of the category;
 *  - SKUs are unique (case-insensitively) and so are axis-value combinations;
 *  - tiers follow the listing tier rules, against the variant's MOQ (else the listing's);
 *  - stock states are consistent (made-to-order needs a lead time, own or the listing's).
 */
export function normaliseVariants(axes: readonly VariantAxis[], inputs: readonly VariantInput[], ctx: VariantContext): { variants: NormalisedVariant[]; errors: string[] } {
  const errors: string[] = [];
  if (!inputs.length) return { variants: [], errors };
  if (inputs.length > MAX_VARIANTS) errors.push(`At most ${MAX_VARIANTS} variants per listing`);
  if (!axes.length) {
    errors.push("This category has no variant axes configured, so listings in it cannot have variants");
    return { variants: [], errors };
  }
  const axisByKey = new Map(axes.map((a) => [a.key, a]));
  const skus = new Set<string>();
  const combos = new Set<string>();
  const out: NormalisedVariant[] = [];
  inputs.forEach((raw, i) => {
    const tag = raw.sku ? `Variant ${raw.sku}` : `Variant ${i + 1}`;
    const sku = raw.sku;
    if (skus.has(sku.toLowerCase())) errors.push(`${tag}: SKU is used twice`);
    skus.add(sku.toLowerCase());

    const values: Record<string, string> = {};
    for (const key of Object.keys(raw.axisValues)) if (!axisByKey.has(key)) errors.push(`${tag}: "${key}" is not a variant axis of this category`);
    for (const axis of axes) {
      const given = raw.axisValues[axis.key]?.trim();
      if (!given) {
        errors.push(`${tag}: ${axis.label} is required`);
        continue;
      }
      if (axis.options) {
        const canonical = axis.options.find((o) => o.toLowerCase() === given.toLowerCase());
        if (!canonical) {
          errors.push(`${tag}: ${axis.label} must be one of: ${axis.options.join(", ")}`);
          continue;
        }
        values[axis.key] = canonical;
      } else {
        values[axis.key] = given;
      }
    }
    if (Object.keys(values).length === axes.length) {
      const combo = axes.map((a) => values[a.key]!.toLowerCase()).join("\u0000");
      if (combos.has(combo)) errors.push(`${tag}: ${axes.map((a) => values[a.key]).join(" / ")} is already defined`);
      combos.add(combo);
    }

    const tiers = raw.priceTiers ?? [];
    const moq = raw.moq ?? null;
    for (const e of validatePriceTiers(tiers, moq ?? ctx.listingMoq)) errors.push(`${tag}: ${e}`);

    const availability = raw.availability ?? "in_stock";
    const availableQty = raw.availableQty ?? null;
    const leadTimeDays = raw.leadTimeDays ?? null;
    errors.push(...validateStock({ availability, availableQty, leadTimeDays: leadTimeDays ?? ctx.listingLeadTimeDays }, tag));

    out.push({ ...(raw.id ? { id: raw.id } : {}), sku, axisValues: values, pricePaise: raw.pricePaise ?? null, priceTiers: tiers, moq, availability, availableQty, leadTimeDays, imageId: raw.imageId ?? null });
  });
  return { variants: out, errors };
}

/**
 * What the buyer pays / must order for one variant: its own price, tiers, MOQ and lead time where set, the listing's otherwise.
 * A variant with its own price but no tiers is a single flat price (the listing's tiers are for the listing's price).
 */
export function effectiveVariantTerms(
  listing: { pricePaise: number | null; priceTiers?: PriceTier[]; moq: number | null; trade?: { leadTimeDays?: number | null } },
  variant: Pick<VariantView, "pricePaise" | "priceTiers" | "moq" | "leadTimeDays"> | null | undefined,
): { pricePaise: number | null; priceTiers: PriceTier[]; moq: number | null; leadTimeDays: number | null } {
  const lead = variant?.leadTimeDays ?? listing.trade?.leadTimeDays ?? null;
  if (!variant) return { pricePaise: listing.pricePaise, priceTiers: listing.priceTiers ?? [], moq: listing.moq, leadTimeDays: lead };
  const ownTiers = variant.priceTiers.length > 0;
  const ownPrice = variant.pricePaise !== null;
  return {
    pricePaise: ownPrice ? variant.pricePaise : listing.pricePaise,
    priceTiers: ownTiers ? variant.priceTiers : ownPrice ? [] : (listing.priceTiers ?? []),
    moq: variant.moq ?? listing.moq,
    leadTimeDays: lead,
  };
}

/** Compact one-line description of a variant for diffs and reviewer screens, e.g. "SKU-M-RED (Size M, Colour Red)". */
export function describeVariant(v: Pick<VariantView, "sku" | "axisValues">, axes: readonly Pick<VariantAxis, "key" | "label">[] = []): string {
  const label = new Map(axes.map((a) => [a.key, a.label]));
  const parts = Object.entries(v.axisValues).map(([k, val]) => `${label.get(k) ?? k} ${val}`);
  return parts.length ? `${v.sku} (${parts.join(", ")})` : v.sku;
}
