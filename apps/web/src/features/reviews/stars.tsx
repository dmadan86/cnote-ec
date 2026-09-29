/** Read-only stars, fractional fill. Decorative glyphs are hidden from assistive tech; the label carries the value. */
export function Stars({ value, className = "text-base" }: { value: number; className?: string }) {
  const pct = Math.max(0, Math.min(100, (value / 5) * 100));
  return (
    <span role="img" aria-label={`${value} out of 5 stars`} className={`relative inline-block whitespace-nowrap leading-none ${className}`}>
      <span aria-hidden className="text-line">★★★★★</span>
      <span aria-hidden className="absolute inset-y-0 left-0 overflow-hidden text-accent-500" style={{ width: `${pct}%` }}>★★★★★</span>
    </span>
  );
}

/** Compact rating for product cards and search results. Renders nothing until a listing has approved ratings. */
export function RatingStars({ average, count }: { average: number; count: number }) {
  if (!count) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted">
      <Stars value={average} className="text-sm" />
      <span className="font-medium text-ink">{average.toFixed(1)}</span>
      <span aria-label={`${count} rating${count === 1 ? "" : "s"}`}>({count})</span>
    </span>
  );
}
