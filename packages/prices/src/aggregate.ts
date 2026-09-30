// Pure benchmark aggregation with strict k-anonymity (ADR-022, ADR-010). No I/O.
//
// A cell is (category, canonical unit, pincode-zone|state|national, tier|all). EVERY cell is evaluated on its own samples, after
// IQR outlier trimming, and published only if it has >= k distinct sellers AND >= k distinct buyers AND no seller
// contributes more than half of the samples. Failing cells are suppressed; readers fall back to coarser published
// cells (zone -> state -> national, tier -> all volumes), which are themselves evaluated with the same rules.
// Counterparty ids exist only on `Sample` and are reduced to counts here: cells never carry them.
import { isZone } from "./regions";
import { quantilesOf, trimOutliers, type Weighted } from "./stats";
import { TIERS, tierOf, type Tier } from "./units";

export interface Sample {
  categoryId: string;
  /** canonical unit */
  unit: string;
  /** paise per canonical unit */
  price: number;
  /** quantity in canonical units */
  quantity: number;
  /** state slug, or null when the delivery area is unknown (counts towards national cells only) */
  region: string | null;
  /** pincode zone key (`pin-560`, first three PIN digits) or null/omitted; a zone cell is evaluated on its own samples like any other */
  zone?: string | null;
  sellerId: string;
  buyerId: string;
  escrow: boolean;
}

export type SuppressReason = "sellers" | "buyers" | "dominance";

export interface CellDraft {
  categoryId: string;
  unit: string;
  region: string;
  tier: Tier | "all";
  p10: number; p25: number; p50: number; p75: number; p90: number;
  sampleCount: number;
  quoteCount: number;
  escrowCount: number;
  sellerCount: number;
  buyerCount: number;
}

export interface AggregateOptions { k: number; escrowWeight: number }

export type CellEvaluation =
  | { ok: true; cell: Omit<CellDraft, "categoryId" | "unit" | "region" | "tier">; used: Sample[] }
  | { ok: false; reason: SuppressReason };

/** Trim, then apply the k-anonymity and dominance rules to one cell's samples. */
export function evaluateCell(samples: readonly Sample[], opts: AggregateOptions): CellEvaluation {
  const used = trimOutliers(samples.map((s) => ({ ...s, value: s.price }))).map(({ value: _v, ...s }) => s as Sample);
  const bySeller = new Map<string, number>();
  const buyers = new Set<string>();
  for (const s of used) {
    bySeller.set(s.sellerId, (bySeller.get(s.sellerId) ?? 0) + 1);
    buyers.add(s.buyerId);
  }
  if (bySeller.size < opts.k) return { ok: false, reason: "sellers" };
  if (buyers.size < opts.k) return { ok: false, reason: "buyers" };
  const max = Math.max(...bySeller.values());
  if (max * 2 > used.length) return { ok: false, reason: "dominance" };
  const weighted: Weighted[] = used.map((s) => ({ value: s.price, weight: s.escrow ? opts.escrowWeight : 1 }));
  const q = quantilesOf(weighted);
  const escrowCount = used.filter((s) => s.escrow).length;
  return {
    ok: true, used,
    cell: {
      p10: q.p10, p25: q.p25, p50: q.p50, p75: q.p75, p90: q.p90,
      sampleCount: used.length, quoteCount: used.length - escrowCount, escrowCount, sellerCount: bySeller.size, buyerCount: buyers.size,
    },
  };
}

export interface AggregateResult {
  cells: CellDraft[];
  /** non-empty candidate cells evaluated (published + suppressed) */
  evaluated: number;
  suppressed: number;
  reasons: Record<SuppressReason, number>;
  categories: number;
}

export function buildCells(samples: readonly Sample[], opts: AggregateOptions): AggregateResult {
  const groups = new Map<string, Sample[]>();
  for (const s of samples) {
    const key = `${s.categoryId}\u0000${s.unit}`;
    const g = groups.get(key);
    if (g) g.push(s); else groups.set(key, [s]);
  }
  const cells: CellDraft[] = [];
  const reasons: Record<SuppressReason, number> = { sellers: 0, buyers: 0, dominance: 0 };
  let evaluated = 0;
  const categories = new Set<string>();
  for (const group of groups.values()) {
    const { categoryId, unit } = group[0]!;
    const regions = ["national", ...new Set(group.flatMap((s) => (s.region ? [s.region] : []))), ...new Set(group.flatMap((s) => (s.zone ? [s.zone] : [])))];
    const withTier = group.map((s) => ({ s, tier: tierOf(unit, s.quantity) }));
    for (const region of regions) {
      const inRegion = region === "national" ? withTier : isZone(region) ? withTier.filter((x) => x.s.zone === region) : withTier.filter((x) => x.s.region === region);
      for (const tier of ["all", ...TIERS] as const) {
        const subset = (tier === "all" ? inRegion : inRegion.filter((x) => x.tier === tier)).map((x) => x.s);
        if (subset.length === 0) continue;
        evaluated++;
        const r = evaluateCell(subset, opts);
        if (!r.ok) { reasons[r.reason]++; continue; }
        categories.add(categoryId);
        cells.push({ categoryId, unit, region, tier, ...r.cell });
      }
    }
  }
  return { cells, evaluated, suppressed: evaluated - cells.length, reasons, categories: categories.size };
}
