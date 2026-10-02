export interface TierRow {
  qty: number;
  pricePaise: number;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "bigint" ? Number(v) : typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Quantity price tiers of one listing, read defensively: another change adds them to the listing view, so this accepts
 * `priceTiers` / `tiers` arrays of `{ minQty | minQuantity | quantity, pricePaise }` and returns [] when absent or malformed.
 */
export function priceTiersOf(listings: unknown[]): TierRow[][];
export function priceTiersOf(listing: unknown): TierRow[];
export function priceTiersOf(input: unknown): TierRow[] | TierRow[][] {
  if (Array.isArray(input)) return input.map((l) => priceTiersOf(l) as TierRow[]);
  const raw = (input as { priceTiers?: unknown; tiers?: unknown } | null)?.priceTiers ?? (input as { tiers?: unknown } | null)?.tiers;
  if (!Array.isArray(raw)) return [];
  const rows: TierRow[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const qty = num(r?.minQty ?? r?.minQuantity ?? r?.quantity ?? r?.qty);
    const price = num(r?.pricePaise);
    if (qty != null && price != null) rows.push({ qty, pricePaise: price });
  }
  return rows.sort((a, b) => a.qty - b.qty);
}
