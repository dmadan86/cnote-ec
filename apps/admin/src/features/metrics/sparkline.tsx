import type { MetricUnit } from "@cnote/metrics";
import { formatValue, sparklinePoints } from "./format";

/** Inline SVG trend line. The svg is described by aria-label; the raw values are in a screen-reader-only table. */
export function Sparkline({ label, unit, series, width = 120, height = 28 }: { label: string; unit: MetricUnit; series: { day: string; value: number }[]; width?: number; height?: number }) {
  if (series.length === 0) return <span className="text-xs text-muted">no data</span>;
  const first = series[0]!;
  const last = series.at(-1)!;
  const summary = `${label}: ${series.length} days, from ${formatValue(unit, first.value)} on ${first.day} to ${formatValue(unit, last.value)} on ${last.day}`;
  const points = sparklinePoints(series.map((s) => s.value), width, height);
  const [lastX, lastY] = points.split(" ").at(-1)!.split(",").map(Number);
  return (
    <>
      <svg role="img" aria-label={summary} viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="text-brand-700">
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={lastX} cy={lastY} r={2.25} fill="currentColor" />
      </svg>
      <table className="sr-only">
        <caption>{label} daily values</caption>
        <thead><tr><th scope="col">Day</th><th scope="col">Value</th></tr></thead>
        <tbody>
          {series.map((s) => (
            <tr key={s.day}><td>{s.day}</td><td>{formatValue(unit, s.value)}</td></tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
