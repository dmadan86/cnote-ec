// Pure presentation helpers for the metrics console (unit-tested; no React).
import type { MetricUnit, ScoreStatus } from "@cnote/metrics";

export function formatValue(unit: MetricUnit, v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  switch (unit) {
    case "ratio":
      return `${(v * 100).toFixed(1)}%`;
    case "minutes":
      return `${v.toFixed(1)} min`;
    case "per_enquiry":
      return v.toFixed(2);
    default:
      return String(Math.round(v));
  }
}

export function formatTarget(unit: MetricUnit, t: { value: number; direction: "at_least" | "below" } | null): string {
  return t ? `${t.direction === "at_least" ? "≥" : "<"} ${formatValue(unit, t.value)}` : "—";
}

export const STATUS_LABEL: Record<ScoreStatus, string> = { met: "On target", missed: "Off target", no_data: "No data", info: "Tracking" };
export const STATUS_TONE: Record<ScoreStatus, "success" | "danger" | "neutral" | "brand"> = { met: "success", missed: "danger", no_data: "neutral", info: "brand" };

/** SVG polyline points for a sparkline in a w x h box (padding p). Flat series render mid-height. */
export function sparklinePoints(values: number[], w: number, h: number, p = 2): string {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  return values
    .map((v, i) => {
      const x = values.length === 1 ? w / 2 : p + (i * (w - 2 * p)) / (values.length - 1);
      const y = span === 0 ? h / 2 : h - p - ((v - min) / span) * (h - 2 * p);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export const RANGES = [7, 28, 90] as const;
export function parseRange(v: string | undefined): number {
  return RANGES.find((d) => String(d) === v) ?? 28;
}
