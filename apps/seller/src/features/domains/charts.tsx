import type { Breakdown, TrafficPoint } from "@cnote/domains";
import { getLocale, getTranslations } from "next-intl/server";
import { type Locale, intlTag } from "@/i18n/config";

/** Accessible dependency-free SVG line chart for two daily series, with a data table for screen readers. */
export async function TrafficChart({ series }: { series: TrafficPoint[] }) {
  const t = await getTranslations("storefront");
  const W = 640, H = 200, P = { l: 36, r: 8, t: 8, b: 22 };
  const max = Math.max(1, ...series.map((p) => Math.max(p.pageviews, p.uniqueVisitors)));
  const x = (i: number) => P.l + (series.length <= 1 ? 0 : (i / (series.length - 1)) * (W - P.l - P.r));
  const y = (v: number) => P.t + (1 - v / max) * (H - P.t - P.b);
  const path = (k: "pageviews" | "uniqueVisitors") => series.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(" ");
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  const labelEvery = Math.max(1, Math.ceil(series.length / 6));
  const total = series.reduce((s, p) => s + p.pageviews, 0);
  return (
    <figure className="space-y-2">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t("charts.aria", { total })} className="h-auto w-full">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} className="stroke-line" strokeWidth={1} />
            <text x={P.l - 6} y={y(t) + 4} textAnchor="end" className="fill-muted" fontSize={11}>{t}</text>
          </g>
        ))}
        <path d={path("pageviews")} fill="none" className="stroke-brand-600" strokeWidth={2} strokeLinejoin="round" />
        <path d={path("uniqueVisitors")} fill="none" className="stroke-accent-700" strokeWidth={2} strokeDasharray="5 3" strokeLinejoin="round" />
        {series.map((p, i) => (i % labelEvery === 0 ? <text key={p.day} x={x(i)} y={H - 6} textAnchor="middle" className="fill-muted" fontSize={11}>{p.day.slice(5)}</text> : null))}
      </svg>
      <figcaption className="flex flex-wrap gap-4 text-xs text-muted">
        <span><span aria-hidden className="mr-1 inline-block h-0.5 w-5 bg-brand-600 align-middle" />{t("analytics.pageViews")}</span>
        <span><span aria-hidden className="mr-1 inline-block w-5 border-t-2 border-dashed border-accent-700 align-middle" />{t("analytics.visitors")}</span>
      </figcaption>
      <details className="text-xs">
        <summary className="cursor-pointer text-brand-700">{t("charts.viewTable")}</summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full text-left">
            <caption className="sr-only">{t("charts.daily")}</caption>
            <thead><tr><th scope="col" className="py-1 pr-4">{t("charts.day")}</th><th scope="col" className="pr-4">{t("analytics.pageViews")}</th><th scope="col" className="pr-4">{t("analytics.visitors")}</th><th scope="col">{t("analytics.requests")}</th></tr></thead>
            <tbody>{series.map((p) => <tr key={p.day} className="border-t border-line"><th scope="row" className="py-1 pr-4 font-normal">{p.day}</th><td>{p.pageviews}</td><td>{p.uniqueVisitors}</td><td>{p.requests}</td></tr>)}</tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

/** Horizontal bars with the number always printed (never colour alone). */
export async function BarList({ title, items, empty, labels }: { title: string; items: Breakdown[]; empty?: string; labels?: Record<string, string> }) {
  const t = await getTranslations("storefront");
  const locale = (await getLocale()) as Locale;
  const max = Math.max(1, ...items.map((i) => i.count));
  const total = items.reduce((s, i) => s + i.count, 0);
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {items.length === 0 ? <p className="text-sm text-muted">{empty ?? t("charts.noData")}</p> : (
        <ul className="space-y-2">
          {items.map((i) => (
            <li key={i.key} className="text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 break-all">{labels?.[i.key] ?? i.key}</span>
                <span className="shrink-0 tabular-nums text-muted">{i.count.toLocaleString(intlTag(locale))}{total ? ` (${Math.round((i.count / total) * 100)}%)` : ""}</span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-canvas" aria-hidden><div className="h-2 rounded-full bg-brand-600" style={{ width: `${Math.max(2, (i.count / max) * 100)}%` }} /></div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
