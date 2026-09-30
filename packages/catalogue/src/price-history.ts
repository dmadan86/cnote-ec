// Append-only price history (ADR-025). The promotions module derives the honest strike-through "reference price" from it:
// the LOWEST price in the 30 days before a price reduction is announced (E-Commerce Amendment Rules 2026 r.4(9), CCPA dark-pattern
// guidelines). It is computed here, from data only the platform writes, and no seller input can reach it.
import { prisma, type Tx } from "@cnote/db";

export const REFERENCE_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

type Db = Pick<Tx, "listingPriceHistory">;

export interface PriceHistoryEntry {
  id: string;
  pricePaise: number | null;
  priceUnit: string | null;
  effectiveFrom: string;
}

/**
 * Appends a row only when the price or unit actually changed from the latest row (idempotent for repeated publishes).
 * Returns true when a row was written. `at` is for backfills and tests; production writes use the clock.
 */
export async function recordPrice(listingId: string, pricePaise: number | null, priceUnit: string | null, db: Db = prisma, at: Date = new Date()): Promise<boolean> {
  const last = await db.listingPriceHistory.findFirst({ where: { listingId }, orderBy: [{ effectiveFrom: "desc" }, { id: "desc" }] });
  const next = pricePaise === null ? null : BigInt(Math.round(pricePaise));
  if (last && last.pricePaise === next && last.priceUnit === priceUnit) return false;
  await db.listingPriceHistory.create({ data: { listingId, pricePaise: next, priceUnit, effectiveFrom: at } });
  return true;
}

/**
 * Lowest listing price (paise) in the [at - 30d, at] window, counting the price that was already in force when the window opened.
 * Returns null when there is NOT a full 30 days of history (the first row is newer than the window start) or no priced row
 * intersects the window: callers must then show the offer price only, with no "was" price and no percentage.
 * Because it is a minimum, raising a price before a sale can never inflate the reference.
 */
export async function referencePrice(listingId: string, at: Date = new Date(), db: Db = prisma): Promise<number | null> {
  const windowStart = new Date(at.getTime() - REFERENCE_WINDOW_DAYS * DAY_MS);
  const rows = await db.listingPriceHistory.findMany({ where: { listingId, effectiveFrom: { lte: at } }, orderBy: [{ effectiveFrom: "asc" }, { id: "asc" }] });
  return lowestInWindow(rows.map((r) => ({ pricePaise: r.pricePaise === null ? null : Number(r.pricePaise), effectiveFrom: r.effectiveFrom })), windowStart, at);
}

/** Pure core of referencePrice, exported for property tests. Rows must be ascending by effectiveFrom. */
export function lowestInWindow(rows: { pricePaise: number | null; effectiveFrom: Date }[], windowStart: Date, at: Date): number | null {
  if (rows.length === 0 || rows[0]!.effectiveFrom > windowStart) return null; // less than 30 days of history
  let min: number | null = null;
  rows.forEach((r, i) => {
    const next = rows[i + 1];
    const inForceUntil = next ? next.effectiveFrom : at;
    // the row was in force during [effectiveFrom, next.effectiveFrom); keep it when that interval touches the window
    if (inForceUntil <= windowStart || r.effectiveFrom > at) return;
    if (r.pricePaise !== null && (min === null || r.pricePaise < min)) min = r.pricePaise;
  });
  return min;
}

export async function priceHistory(listingId: string, limit = 200): Promise<PriceHistoryEntry[]> {
  const rows = await prisma.listingPriceHistory.findMany({ where: { listingId }, orderBy: [{ effectiveFrom: "desc" }, { id: "desc" }], take: limit });
  return rows.map((r) => ({ id: r.id, pricePaise: r.pricePaise === null ? null : Number(r.pricePaise), priceUnit: r.priceUnit, effectiveFrom: r.effectiveFrom.toISOString() }));
}
