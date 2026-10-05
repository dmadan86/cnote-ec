// Variant selection logic for the product page (docs/design/variants-stock.md). Pure and client-safe: it mirrors
// @cnote/catalogue's effectiveVariantTerms / bestAvailability without importing that Prisma-backed package into client code.
import type { Tier } from "./tiers";

export type Availability = "in_stock" | "made_to_order" | "out_of_stock";

export interface PdpAxis {
  key: string;
  label: string;
}

export interface PdpVariant {
  id: string;
  sku: string;
  axisValues: Record<string, string>;
  pricePaise: number | null;
  priceTiers: Tier[];
  moq: number | null;
  availability: Availability;
  availableQty: number | null;
  leadTimeDays: number | null;
  imageId: string | null;
  sortOrder: number;
}

/** axis key -> chosen value */
export type Picks = Record<string, string>;

const RANK: Record<Availability, number> = { in_stock: 2, made_to_order: 1, out_of_stock: 0 };
export const bestOf = (xs: readonly Availability[]): Availability => xs.reduce<Availability>((a, x) => (RANK[x] > RANK[a] ? x : a), "out_of_stock");

/** "M / Red": the axis values in axis order. */
export function variantName(v: Pick<PdpVariant, "axisValues">, axes: readonly PdpAxis[]): string {
  return axes.map((a) => v.axisValues[a.key]).filter(Boolean).join(" / ");
}

/** The variant that matches a choice for EVERY axis (undefined while the choice is incomplete or the combination does not exist). */
export function findVariant(variants: readonly PdpVariant[], axes: readonly PdpAxis[], picks: Picks): PdpVariant | undefined {
  if (!axes.length || axes.some((a) => !picks[a.key])) return undefined;
  return variants.find((v) => axes.every((a) => v.axisValues[a.key] === picks[a.key]));
}

export function picksOf(v: PdpVariant | undefined | null): Picks {
  return v ? { ...v.axisValues } : {};
}

/** Variants that offer `value` on `axis` and agree with every other axis already chosen. */
function candidates(variants: readonly PdpVariant[], picks: Picks, axis: string, value: string): PdpVariant[] {
  return variants.filter((v) => v.axisValues[axis] === value && Object.entries(picks).every(([k, val]) => k === axis || v.axisValues[k] === val));
}

/**
 * What choosing `value` on `axis` would give, given the other choices: the best availability among matching variants, or null when no
 * variant combines it with the other current choices (choosing it then also changes those, see resolveChoice).
 */
export function optionAvailability(variants: readonly PdpVariant[], picks: Picks, axis: string, value: string): Availability | null {
  const c = candidates(variants, picks, axis, value);
  return c.length ? bestOf(c.map((v) => v.availability)) : null;
}

/**
 * New choices after the buyer picks `value` on `axis`. If that keeps a real combination the other choices stay; otherwise the
 * first variant (display order) offering the value is adopted wholesale, so the selection never points at a variant that does not exist.
 */
export function resolveChoice(variants: readonly PdpVariant[], picks: Picks, axis: string, value: string): Picks {
  const next = { ...picks, [axis]: value };
  const keep = candidates(variants, picks, axis, value);
  if (keep.length) return next;
  const fallback = variants.filter((v) => v.axisValues[axis] === value).sort((a, b) => a.sortOrder - b.sortOrder)[0];
  return fallback ? picksOf(fallback) : next;
}

/** Distinct values of an axis in the order variants are displayed. */
export function axisValues(variants: readonly PdpVariant[], axis: string): string[] {
  const out: string[] = [];
  for (const v of [...variants].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const x = v.axisValues[axis];
    if (x && !out.includes(x)) out.push(x);
  }
  return out;
}

export interface Terms {
  pricePaise: number | null;
  priceTiers: Tier[];
  moq: number | null;
  leadTimeDays: number | null;
}

/** The variant's own price / tiers / MOQ / lead time where set, the listing's otherwise. A variant price without tiers is a flat price. */
export function variantTerms(listing: Terms, v: PdpVariant | null | undefined): Terms {
  if (!v) return listing;
  const ownPrice = v.pricePaise !== null;
  const ownTiers = v.priceTiers.length > 0;
  return {
    pricePaise: ownPrice ? v.pricePaise : listing.pricePaise,
    priceTiers: ownTiers ? v.priceTiers : ownPrice ? [] : listing.priceTiers,
    moq: v.moq ?? listing.moq,
    leadTimeDays: v.leadTimeDays ?? listing.leadTimeDays,
  };
}

/** Lowest unit price across variants (variant tiers' best slab included), for the "From" line before a variant is chosen. */
export function lowestPrice(listing: Terms, variants: readonly PdpVariant[]): number | null {
  const prices: number[] = [];
  for (const v of variants.length ? variants : [null]) {
    const t = variantTerms(listing, v);
    if (t.pricePaise !== null) prices.push(t.pricePaise);
    for (const x of t.priceTiers) prices.push(x.pricePaise);
  }
  return prices.length ? Math.min(...prices) : null;
}

/** `?v=<sku>` value -> the variant, ignoring unknown skus. */
export function variantBySku(variants: readonly PdpVariant[], sku: string | null | undefined): PdpVariant | undefined {
  return sku ? variants.find((v) => v.sku === sku) : undefined;
}
