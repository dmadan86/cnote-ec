// Pure projection of stock + variants into the shape stored on a LIVE row (docs/design/variants-stock.md).
//
// A published version freezes the variants' STRUCTURE (sku, axis values, price, tiers, MOQ, image). Stock is operational and moves
// faster than moderation, so the publisher overlays the CURRENT stock of the working copy on top of the snapshot, and the stock
// fast path (stock.ts) keeps LIVE converged between publishes using the very same functions.
import { effectiveAvailability, type Availability } from "./availability";
import { variantValueKeys, type VariantAxis, type VariantView } from "./variants";

/** Current stock of the working copy (authoring DB) for one listing. */
export interface WorkingStock {
  availability: Availability;
  availableQty: number | null;
  stockUpdatedAt: Date | null;
  variants: { id: string; availability: Availability; availableQty: number | null; leadTimeDays: number | null; stockUpdatedAt: Date | null }[];
}

export interface LiveStock {
  availability: Availability;
  availableQty: number | null;
  stockUpdatedAt: Date | null;
  variantAxes: VariantAxis[];
  variants: VariantView[];
  variantValues: string[];
}

const latest = (dates: (Date | null)[]): Date | null => dates.reduce<Date | null>((a, d) => (d && (!a || d > a) ? d : a), null);

/**
 * Overlays the working copy's current stock on the snapshot's variants (matched by id; a variant without a working row, e.g. one
 * deleted after submission, keeps the stock frozen in the snapshot). `publicImageIds` limits variant images to those buyers can see.
 */
export function buildLiveStock(
  snap: { availability?: Availability; availableQty?: number | null; variantAxes?: VariantAxis[]; variants?: VariantView[] },
  working: WorkingStock | null,
  publicImageIds: ReadonlySet<string>,
): LiveStock {
  const byId = new Map((working?.variants ?? []).map((v) => [v.id, v]));
  const variants = (snap.variants ?? []).map((v, i): VariantView => {
    const w = byId.get(v.id);
    return {
      ...v,
      availability: w?.availability ?? v.availability,
      availableQty: w ? w.availableQty : v.availableQty,
      leadTimeDays: w ? w.leadTimeDays : v.leadTimeDays,
      imageId: v.imageId && publicImageIds.has(v.imageId) ? v.imageId : null,
      sortOrder: i,
    };
  });
  const own = working?.availability ?? snap.availability ?? "in_stock";
  return {
    availability: effectiveAvailability(own, variants),
    availableQty: working ? working.availableQty : (snap.availableQty ?? null),
    stockUpdatedAt: working ? latest([working.stockUpdatedAt, ...working.variants.map((v) => v.stockUpdatedAt)]) : null,
    variantAxes: variants.length ? (snap.variantAxes ?? []) : [],
    variants,
    variantValues: variantValueKeys(variants),
  };
}

/**
 * Stock-only refresh of an existing LIVE row: variants keep their frozen structure and take the working copy's stock when a working
 * row with the same id exists. Never adds or removes a variant (that is a content change and needs a published version).
 */
export function refreshLiveStock(
  live: { variants: VariantView[]; variantAxes: VariantAxis[] },
  working: WorkingStock,
): Pick<LiveStock, "availability" | "availableQty" | "stockUpdatedAt" | "variants"> {
  const byId = new Map(working.variants.map((v) => [v.id, v]));
  const variants = live.variants.map((v) => {
    const w = byId.get(v.id);
    return w ? { ...v, availability: w.availability, availableQty: w.availableQty, leadTimeDays: w.leadTimeDays } : v;
  });
  return {
    availability: effectiveAvailability(working.availability, variants),
    availableQty: working.availableQty,
    stockUpdatedAt: latest([working.stockUpdatedAt, ...working.variants.filter((v) => live.variants.some((l) => l.id === v.id)).map((v) => v.stockUpdatedAt)]),
    variants,
  };
}
