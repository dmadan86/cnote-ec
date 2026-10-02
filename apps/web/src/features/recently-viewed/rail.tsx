"use client";
// "Recently viewed" rail and the view tracker: client islands, so the home page and the product page stay static.
// The list lives on this device (see store.ts for the consent rules); the rail renders nothing until there is something to show.
import { Money, Rail } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { LocaleLink as Link } from "@/i18n/link";
import { ProductImage } from "@/features/search/product-image";
import { clearRecent, recordView, useRecentIds } from "./store";

interface RecentItem {
  id: string;
  href: string;
  title: string;
  image: string | null;
  blur: string | null;
  pricePaise: number | null;
  unit: string | null;
}

/** Records that this product page was opened. Renders nothing. */
export function RecentlyViewedTracker({ id }: { id: string }) {
  useEffect(() => {
    recordView(id);
  }, [id]);
  return null;
}

export function RecentlyViewedRail({ excludeId, className }: { excludeId?: string; className?: string }) {
  const t = useTranslations("convenience");
  const headingId = useId();
  const ids = useRecentIds();
  const wanted = ids.filter((i) => i !== excludeId?.toLowerCase());
  const key = wanted.join(",");
  const [answer, setAnswer] = useState<{ key: string; items: RecentItem[] } | null>(null);

  useEffect(() => {
    if (!key) return;
    const ctl = new AbortController();
    fetch(`/api/recently-viewed?ids=${key}`, { signal: ctl.signal, credentials: "omit", headers: { accept: "application/json" } })
      .then((r) => (r.ok ? (r.json() as Promise<{ items: RecentItem[] }>) : { items: [] }))
      .then((d) => setAnswer({ key, items: d.items }))
      .catch(() => undefined);
    return () => ctl.abort();
  }, [key]);

  const items = key && answer?.key === key ? answer.items : [];
  if (!items.length) return null;
  return (
    <section aria-labelledby={headingId} className={className} data-testid="recently-viewed">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 id={headingId} className="text-xl font-bold tracking-tight text-ink sm:text-[22px]">
          {t("recent.title")}
        </h2>
        <button type="button" onClick={clearRecent} className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-brand-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-brand-600">
          {t("recent.clear")}
        </button>
      </div>
      <Rail className="md:grid-cols-4 xl:grid-cols-6">
        {items.map((p) => (
          <li key={p.id} className="overflow-hidden rounded-card border border-line bg-surface">
            <Link href={p.href} className="block focus-visible:outline-2 focus-visible:outline-brand-600">
              <div className="relative aspect-square w-full bg-canvas">
                <ProductImage src={p.image ?? undefined} blur={p.blur} sizes="(min-width: 1280px) 15vw, (min-width: 640px) 30vw, 45vw" />
              </div>
              <div className="flex flex-col gap-1 p-3">
                <span className="line-clamp-2 text-sm font-medium text-ink">{p.title}</span>
                {p.pricePaise != null ? <Money paise={p.pricePaise} unit={p.unit} className="text-sm" /> : <span className="text-sm text-muted">{t("recent.priceOnRequest")}</span>}
              </div>
            </Link>
          </li>
        ))}
      </Rail>
    </section>
  );
}
