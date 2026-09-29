import type { RatingSummary } from "@cnote/reviews";

export function Histogram({ summary }: { summary: RatingSummary }) {
  return (
    <ul aria-label="Ratings breakdown" className="space-y-1.5">
      {[5, 4, 3, 2, 1].map((star) => {
        const n = summary.histogram[star - 1] ?? 0;
        const pct = summary.count ? Math.round((n / summary.count) * 100) : 0;
        return (
          <li key={star} className="flex items-center gap-2 text-sm">
            <span className="w-12 shrink-0 text-muted">{star} star{star === 1 ? "" : "s"}</span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-line" aria-hidden>
              <span className="block h-full rounded-full bg-accent-600" style={{ width: `${pct}%` }} />
            </span>
            <span className="w-8 shrink-0 text-right tabular-nums text-muted">{n}<span className="sr-only"> reviews ({pct}%)</span></span>
          </li>
        );
      })}
    </ul>
  );
}
