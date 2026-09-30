// Pure statistics for benchmarks (ADR-022).
export interface Weighted { value: number; weight: number }

/**
 * Weighted percentile, "type 1" (no interpolation): the smallest value whose cumulative weight reaches q of the total.
 * `sorted` must be ascending by value. With unit weights this is the nearest-rank percentile.
 */
export function weightedPercentile(sorted: readonly Weighted[], q: number): number {
  if (sorted.length === 0) throw new Error("empty sample");
  const total = sorted.reduce((a, s) => a + s.weight, 0);
  const target = Math.min(1, Math.max(0, q)) * total;
  let cum = 0;
  for (const s of sorted) {
    cum += s.weight;
    if (cum + 1e-9 >= target) return s.value;
  }
  return sorted[sorted.length - 1]!.value;
}

export interface Quantiles { p10: number; p25: number; p50: number; p75: number; p90: number }

export function quantilesOf(items: readonly Weighted[]): Quantiles {
  const sorted = [...items].sort((a, b) => a.value - b.value);
  return {
    p10: weightedPercentile(sorted, 0.1), p25: weightedPercentile(sorted, 0.25), p50: weightedPercentile(sorted, 0.5),
    p75: weightedPercentile(sorted, 0.75), p90: weightedPercentile(sorted, 0.9),
  };
}

/** Linear-interpolated quantile of an ascending numeric array (used for the IQR fences only). */
export function interpolated(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Below this many samples an IQR is meaningless, so nothing is trimmed. */
export const MIN_SAMPLES_FOR_TRIM = 8;

/** Drops values outside [Q1 - 1.5 IQR, Q3 + 1.5 IQR]. Never drops everything; a no-op for small samples. */
export function trimOutliers<T extends { value: number }>(items: readonly T[]): T[] {
  if (items.length < MIN_SAMPLES_FOR_TRIM) return [...items];
  const sorted = items.map((i) => i.value).sort((a, b) => a - b);
  const q1 = interpolated(sorted, 0.25);
  const q3 = interpolated(sorted, 0.75);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  const kept = items.filter((i) => i.value >= lo && i.value <= hi);
  return kept.length > 0 ? kept : [...items];
}
