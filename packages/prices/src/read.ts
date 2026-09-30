// Read side (ADR-022): public-safe benchmark lookup for the RFQ hint, and the seller competitiveness signals.
// Only published cells are ever read; nothing here can return a counterparty id (cells do not store any).
import { getActiveSubscription, listPlans } from "@cnote/billing";
import { getCategoryBySlug, listSellerListings } from "@cnote/catalogue";
import { getTrustProfiles } from "@cnote/identity";
import { prisma, type PriceBenchmark } from "@cnote/db";
import { priceIntelEnabled } from "./config";
import { regionLabel, stateFromPincode, stateSlug, zoneFromPincode } from "./regions";
import { normaliseUnit, tierOf } from "./units";

export interface BenchmarkQuery {
  categoryId?: string | null;
  categorySlug?: string | null;
  quantity?: number | null;
  /** the unit the caller wants prices in (e.g. the RFQ's unit); unknown/omitted: the category's best-sampled unit */
  unit?: string | null;
  pincode?: string | null;
  /** state name or slug, used when there is no pincode */
  state?: string | null;
}

/** Public-safe: aggregates only, always labelled indicative. Prices are paise per `unit` (the requested unit when known). */
export interface PublicBenchmark {
  indicative: true;
  unit: string;
  period: string;
  scope: { region: string; regionLabel: string; volume: "band" | "all"; rolledUp: boolean };
  p25Paise: number;
  medianPaise: number;
  p75Paise: number;
  sampleCount: number;
  /** median change vs the previous period's same cell, in basis points; null when there is no previous cell */
  trendBps: number | null;
}

interface Resolved { cell: PriceBenchmark; factor: number; displayUnit: string; rolledUp: boolean; trendBps: number | null }

async function categoryIdOf(q: BenchmarkQuery): Promise<string | null> {
  if (q.categoryId) return q.categoryId;
  if (!q.categorySlug) return null;
  return (await getCategoryBySlug(q.categorySlug))?.id ?? null;
}

/** pincode zone -> state -> national, volume band -> all volumes: the first published cell wins. */
export async function resolveCell(q: BenchmarkQuery): Promise<Resolved | null> {
  const categoryId = await categoryIdOf(q);
  if (!categoryId) return null;
  const requested = normaliseUnit(q.unit);
  const latest = await prisma.priceBenchmark.findFirst({ where: { categoryId, status: "published", ...(requested ? { unit: requested.unit } : {}) }, orderBy: [{ period: "desc" }] });
  if (!latest) return null;
  let unit = requested?.unit ?? latest.unit;
  if (!requested) {
    // no unit asked for: use the unit with the most samples in the newest period
    const best = await prisma.priceBenchmark.findMany({ where: { categoryId, status: "published", period: latest.period, region: "national", tier: "all" }, orderBy: { sampleCount: "desc" }, take: 1 });
    unit = best[0]?.unit ?? latest.unit;
  }
  const period = (await prisma.priceBenchmark.findFirst({ where: { categoryId, unit, status: "published" }, orderBy: [{ period: "desc" }], select: { period: true } }))?.period;
  if (!period) return null;
  const zone = zoneFromPincode(q.pincode);
  const state = stateFromPincode(q.pincode) ?? stateSlug(q.state);
  const qty = q.quantity && q.quantity > 0 ? q.quantity * (requested?.factor ?? 1) : null;
  const tier = qty ? tierOf(unit, qty) : null;
  // Most specific published cell wins, geography narrowing zone -> state -> national inside each volume choice (band before all volumes).
  const geos = [...(zone ? [zone] : []), ...(state ? [state] : []), "national"];
  const wantGeo = geos[0]!;
  const tries: [string, string, boolean][] = [];
  for (const t of [...(tier ? [tier] : []), "all"]) for (const g of geos) tries.push([g, t, g !== wantGeo || t !== (tier ?? "all")]);
  for (const [r, t, rolledUp] of tries) {
    const cell = await prisma.priceBenchmark.findFirst({ where: { categoryId, unit, period, region: r, tier: t, status: "published" } });
    if (!cell) continue;
    const prev = await prisma.priceBenchmark.findFirst({ where: { categoryId, unit, region: r, tier: t, status: "published", period: { lt: period } }, orderBy: { period: "desc" } });
    const trendBps = prev && prev.p50Paise > 0n ? Math.round(((Number(cell.p50Paise) - Number(prev.p50Paise)) / Number(prev.p50Paise)) * 10_000) : null;
    return { cell, factor: requested?.factor ?? 1, displayUnit: requested ? (q.unit ?? unit).trim() : unit, rolledUp, trendBps };
  }
  return null;
}

const show = (canonPaise: bigint, factor: number) => Math.round(Number(canonPaise) * factor);

/**
 * "Typical price range for this category/quantity in your state" for the RFQ form (and any JSON endpoint).
 * Returns null while PRICE_INTEL_ENABLED is off or when no published cell covers the request.
 */
export async function getPublicBenchmark(q: BenchmarkQuery): Promise<PublicBenchmark | null> {
  if (!priceIntelEnabled()) return null;
  const r = await resolveCell(q);
  if (!r) return null;
  const { cell } = r;
  return {
    indicative: true,
    unit: r.displayUnit,
    period: cell.period,
    scope: { region: cell.region, regionLabel: regionLabel(cell.region), volume: cell.tier === "all" ? "all" : "band", rolledUp: r.rolledUp },
    p25Paise: show(cell.p25Paise, r.factor),
    medianPaise: show(cell.p50Paise, r.factor),
    p75Paise: show(cell.p75Paise, r.factor),
    sampleCount: cell.sampleCount,
    trendBps: r.trendBps,
  };
}

// ---------------------------------------------------------------------------------------------
// Seller competitiveness (premium analytics tier)
// ---------------------------------------------------------------------------------------------

/** Plan feature string that gates the premium tier. If no plan lists it, every paid plan (not "free") qualifies. */
export const PRICE_INTEL_PLAN_FEATURE = "Price intelligence";

export async function hasPriceIntelPlan(businessId: string): Promise<boolean> {
  const sub = await getActiveSubscription(businessId);
  if (!sub || sub.planCode === "free") return false;
  const plans = await listPlans();
  const gated = plans.filter((p) => p.features.some((f) => f.toLowerCase().includes(PRICE_INTEL_PLAN_FEATURE.toLowerCase())));
  return gated.length === 0 ? true : gated.some((p) => p.code === sub.planCode);
}

export type Position = "below" | "within" | "above" | "no_data";
export type Trend = "up" | "down" | "flat" | "unknown";

export interface CompetitivenessItem {
  listingId: string;
  title: string;
  categoryName: string;
  pricePaise: number;
  priceUnit: string;
  position: Position;
  /** listing price vs the benchmark median, basis points (positive = dearer); null with no data */
  vsMedianBps: number | null;
  band: { p25Paise: number; medianPaise: number; p75Paise: number; unit: string; regionLabel: string; period: string; rolledUp: boolean } | null;
  trend: Trend;
  trendBps: number | null;
}

export type SellerCompetitiveness =
  | { enabled: false }
  | { enabled: true; premium: false }
  | { enabled: true; premium: true; items: CompetitivenessItem[] };

export const FLAT_TREND_BPS = 200;
export const trendOf = (bps: number | null): Trend => (bps === null ? "unknown" : bps > FLAT_TREND_BPS ? "up" : bps < -FLAT_TREND_BPS ? "down" : "flat");
export const positionOf = (price: number, p25: number, p75: number): Position => (price < p25 ? "below" : price > p75 ? "above" : "within");

/** Where each live listing's price sits against its benchmark band. Gated by the plan; the free tier gets `premium: false`. */
export async function getSellerCompetitiveness(businessId: string): Promise<SellerCompetitiveness> {
  if (!priceIntelEnabled()) return { enabled: false };
  if (!(await hasPriceIntelPlan(businessId))) return { enabled: true, premium: false };
  const [listings, profiles] = await Promise.all([listSellerListings(businessId), getTrustProfiles([businessId])]);
  const profile = profiles.get(businessId);
  const items: CompetitivenessItem[] = [];
  for (const l of listings) {
    if (l.status !== "published" || l.pricePaise === null || !l.priceUnit) continue;
    const r = await resolveCell({ categoryId: l.category.id, quantity: l.moq, unit: l.priceUnit, pincode: profile?.pincode, state: profile?.state });
    const base = { listingId: l.id, title: l.title, categoryName: l.category.name, pricePaise: l.pricePaise, priceUnit: l.priceUnit };
    if (!r) { items.push({ ...base, position: "no_data", vsMedianBps: null, band: null, trend: "unknown", trendBps: null }); continue; }
    const p25 = show(r.cell.p25Paise, r.factor);
    const med = show(r.cell.p50Paise, r.factor);
    const p75 = show(r.cell.p75Paise, r.factor);
    items.push({
      ...base, position: positionOf(l.pricePaise, p25, p75), vsMedianBps: med > 0 ? Math.round(((l.pricePaise - med) / med) * 10_000) : null,
      band: { p25Paise: p25, medianPaise: med, p75Paise: p75, unit: r.displayUnit, regionLabel: regionLabel(r.cell.region), period: r.cell.period, rolledUp: r.rolledUp },
      trend: trendOf(r.trendBps), trendBps: r.trendBps,
    });
  }
  return { enabled: true, premium: true, items };
}
