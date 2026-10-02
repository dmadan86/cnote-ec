// Quantity price slabs for the product page. All money is integer paise (CLAUDE.md); the only float is display formatting.
// Pure and framework-free so it is unit-tested (test/pdp-tiers.test.ts).

/** Same shape as @cnote/catalogue's PriceTier (not imported: client code must not pull in the Prisma-backed package). */
export interface Tier {
  minQty: number;
  pricePaise: number;
}

/** A row of the slab table: `to` is null for the open-ended last slab. */
export interface Slab {
  from: number;
  to: number | null;
  pricePaise: number;
}

/**
 * Slab rows for display and selection. `tiers` are the seller's slabs (ascending, first >= MOQ). When the first slab starts
 * above the MOQ, the listing's base price covers MOQ..first-1 and becomes the first row. With no tiers (or no usable
 * input) the result is empty and the page shows the single price.
 */
export function buildSlabs(tiers: readonly Tier[] | undefined, basePaise: number | null, moq: number | null): Slab[] {
  const t = [...(tiers ?? [])].filter((x) => Number.isInteger(x.minQty) && x.minQty >= 1 && Number.isSafeInteger(x.pricePaise) && x.pricePaise >= 0).sort((a, b) => a.minQty - b.minQty);
  if (!t.length) return [];
  const rows: { from: number; pricePaise: number }[] = [];
  const floor = Math.max(1, moq ?? 1);
  if (t[0]!.minQty > floor && basePaise != null) rows.push({ from: floor, pricePaise: basePaise });
  for (const x of t) rows.push({ from: x.minQty, pricePaise: x.pricePaise });
  return rows.map((r, i) => ({ from: r.from, to: i + 1 < rows.length ? rows[i + 1]!.from - 1 : null, pricePaise: r.pricePaise }));
}

/** Index of the slab that prices `qty`; quantities below the first row use the first row (the buyer is under MOQ). -1 if there are no slabs. */
export function activeSlabIndex(slabs: readonly Slab[], qty: number): number {
  if (!slabs.length) return -1;
  let idx = 0;
  slabs.forEach((s, i) => {
    if (qty >= s.from) idx = i;
  });
  return idx;
}

/** Unit price for a quantity: the active slab's price, else the listing's base price (null = price on request). */
export function unitPriceFor(slabs: readonly Slab[], basePaise: number | null, qty: number): number | null {
  const i = activeSlabIndex(slabs, qty);
  return i >= 0 ? slabs[i]!.pricePaise : basePaise;
}

/** unit paise x whole quantity, exact (BigInt) and null when the result is not a safe integer. Excludes GST. */
export function estimateTotalPaise(unitPaise: number | null, qty: number): number | null {
  if (unitPaise == null || !Number.isInteger(qty) || qty < 1) return null;
  const total = BigInt(unitPaise) * BigInt(qty);
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
}

/** Parses the quantity input: whole numbers only (digits, grouping commas/spaces tolerated), 1..2e9; otherwise null. */
export function parseQty(raw: string): number | null {
  const s = raw.replace(/[\s,]/g, "");
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 2_000_000_000 ? n : null;
}

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
/** "₹1,999" / "₹12.50" (paise -> rupees only here, at the display edge). */
export function formatPaise(paise: number): string {
  const text = inr.format(paise / 100);
  return paise % 100 === 0 ? text.replace(/\.00$/, "") : text;
}
