// @cnote/prices: ADR-022 price intelligence: k-anonymous regional, volume-tiered category benchmarks from quotes and escrow orders. Flag PRICE_INTEL_ENABLED.
// PUBLIC CONTRACT.
export { worker, runNightlyIfDue } from "./worker";
export {
  priceIntelEnabled, assertPriceIntelEnabled, getK, setK, clampK, DEFAULT_K, MIN_K, MAX_K, WINDOW_DAYS, escrowWeight,
} from "./config";
export { runBenchmarks, toSamples, periodOf, type RunResult } from "./run";
export { buildCells, evaluateCell, type Sample, type CellDraft, type AggregateOptions, type AggregateResult, type SuppressReason } from "./aggregate";
export { normaliseUnit, normaliseFact, tierOf, TIERS, type NormalUnit, type Tier } from "./units";
export { stateFromPincode, stateSlug, regionLabel, REGION_SLUGS } from "./regions";
export { weightedPercentile, quantilesOf, trimOutliers, interpolated, type Weighted, type Quantiles } from "./stats";
export {
  getPublicBenchmark, getSellerCompetitiveness, hasPriceIntelPlan, resolveCell, positionOf, trendOf, PRICE_INTEL_PLAN_FEATURE, FLAT_TREND_BPS,
  type BenchmarkQuery, type PublicBenchmark, type SellerCompetitiveness, type CompetitivenessItem, type Position, type Trend,
} from "./read";
export { listRuns, adminSummary, listCells, unpublishCell, republishCell, type RunRow, type CellRow, type AdminSummary } from "./admin";
