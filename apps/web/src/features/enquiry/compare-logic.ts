import type { ComparisonRow } from "@cnote/enquiry";

export type SortKey = "rank" | "price" | "total" | "leadTime" | "tier";
export const SORT_KEYS: readonly SortKey[] = ["rank", "price", "total", "leadTime", "tier"];
export type BestColumn = "rank" | "price" | "total" | "leadTime" | "tier";

const num: Record<SortKey, (r: ComparisonRow) => number> = {
  rank: (r) => r.rank,
  // A per-line quote has no single unit price, and a partial quote's lower total is not comparable: neither can be "best" here (the line matrix compares per line).
  price: (r) => (r.coverage ? Number.POSITIVE_INFINITY : r.quote.pricePaise),
  total: (r) => (r.coverage && r.coverage.quoted < r.coverage.of ? Number.POSITIVE_INFINITY : r.totalPaise),
  // A missing lead time sorts last rather than looking "fastest".
  leadTime: (r) => r.quote.leadTimeDays ?? Number.POSITIVE_INFINITY,
  tier: (r) => -r.verificationTier,
};

/** New array sorted ascending by the key (tier: highest first); ties fall back to supplier rank, then match id (stable). */
export function sortRows(rows: ComparisonRow[], key: SortKey): ComparisonRow[] {
  return [...rows].sort((a, b) => num[key](a) - num[key](b) || a.rank - b.rank || a.matchId.localeCompare(b.matchId) || 0);
}

/**
 * Which rows hold the best value in each comparable column. A column has no "best" when fewer than two rows have a
 * value or every value is equal (nothing to prefer). Ties all count as best.
 */
export function bestByColumn(rows: ComparisonRow[]): Record<BestColumn, Set<string>> {
  const out = { rank: new Set<string>(), price: new Set<string>(), total: new Set<string>(), leadTime: new Set<string>(), tier: new Set<string>() };
  (Object.keys(out) as BestColumn[]).forEach((col) => {
    const vals = rows.map((r) => ({ id: r.matchId, v: num[col](r) })).filter((x) => Number.isFinite(x.v));
    if (vals.length < 2) return;
    const best = Math.min(...vals.map((x) => x.v));
    if (vals.every((x) => x.v === best)) return;
    vals.filter((x) => x.v === best).forEach((x) => out[col].add(x.id));
  });
  return out;
}
