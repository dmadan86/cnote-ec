// Stock / availability (docs/design/variants-stock.md). Pure helpers: no database, no framework.
//
// Availability is OPERATIONAL data. A seller flipping a product to "out of stock" must take effect in seconds, so it never
// waits for moderation (ADR-033 covers content; stock is a fact about the seller's warehouse). It is stored on the working
// copy, projected straight into the LIVE read database and announced with ListingAvailabilityChanged.
import { z } from "zod";

export const AVAILABILITIES = ["in_stock", "made_to_order", "out_of_stock"] as const;
export type Availability = (typeof AVAILABILITIES)[number];
export const availabilitySchema = z.enum(AVAILABILITIES);
export const isAvailability = (v: unknown): v is Availability => typeof v === "string" && (AVAILABILITIES as readonly string[]).includes(v);

/** Higher = better for the buyer. Used to roll variants up into one listing-level state. */
const RANK: Record<Availability, number> = { in_stock: 2, made_to_order: 1, out_of_stock: 0 };

/** The best state among the given ones; "out_of_stock" when there is none. */
export function bestAvailability(states: readonly Availability[]): Availability {
  let best: Availability = "out_of_stock";
  for (const s of states) if (RANK[s] > RANK[best]) best = s;
  return best;
}

/**
 * What a buyer sees for the listing: the listing's own state when it has no variants, otherwise the best of its variants
 * (a listing is "in stock" when any variant can ship today).
 */
export function effectiveAvailability(own: Availability, variants: readonly { availability: Availability }[]): Availability {
  return variants.length ? bestAvailability(variants.map((v) => v.availability)) : own;
}

/** A buyer can order (now or after the lead time). */
export const isOrderable = (a: Availability): boolean => a !== "out_of_stock";

/** Moving from "cannot order" to "can order": the back-in-stock transition. */
export const isBackInStock = (from: Availability, to: Availability): boolean => from === "out_of_stock" && to !== "out_of_stock";

export const MAX_AVAILABLE_QTY = 2_000_000_000;
export const MAX_LEAD_TIME_DAYS = 730;

/**
 * Consistency rules for one stock state. `leadTimeDays` is the EFFECTIVE lead time (the variant's own, else the listing's).
 * Returns human-readable problems (empty = valid).
 */
export function validateStock(s: { availability: Availability; availableQty: number | null | undefined; leadTimeDays: number | null | undefined }, label = ""): string[] {
  const p = label ? `${label}: ` : "";
  const errs: string[] = [];
  if (s.availability === "made_to_order" && (s.leadTimeDays === null || s.leadTimeDays === undefined)) errs.push(`${p}lead time (days) is required for made-to-order`);
  if (s.availableQty !== null && s.availableQty !== undefined) {
    if (!Number.isInteger(s.availableQty) || s.availableQty < 0 || s.availableQty > MAX_AVAILABLE_QTY) errs.push(`${p}available quantity must be a whole number, 0 or more`);
    else if (s.availability === "out_of_stock" && s.availableQty > 0) errs.push(`${p}an out-of-stock item cannot have quantity available`);
    else if (s.availability === "in_stock" && s.availableQty === 0) errs.push(`${p}quantity 0 means out of stock`);
  }
  return errs;
}
