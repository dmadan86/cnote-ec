import { ProductCardSkeleton, Rail } from "@cnote/ui";
import { getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import type { ListingView } from "@cnote/catalogue";
import { ListingCard } from "@/features/search/cards";
import { loadFeatured, loadRatings } from "@/features/search/data";
import { RailSwitcher } from "./rail-switcher";

function Cards({ items, ratings, priority, locale, empty }: { items: ListingView[]; ratings: Record<string, { average: number; count: number }>; priority?: boolean; locale: Locale; empty: string }) {
  if (!items.length) {
    return <p className="rounded-card border border-dashed border-line bg-surface px-4 py-10 text-center text-sm text-muted">{empty}</p>;
  }
  return (
    <Rail className="md:grid-cols-4 xl:grid-cols-8">
      {items.map((l, i) => (
        <ListingCard key={l.id} listing={l} rating={ratings[l.id]} priority={priority && i < 2} locale={locale} />
      ))}
    </Rail>
  );
}

/**
 * Rail → data mapping (Phase 1 has no per-buyer personalisation or sales counters):
 * business/best → catalogue "popular"; trending → the next window of "popular"; new → "new".
 * Static, Redis + data-cache backed; only the tab switch is client-side.
 */
export async function PopularRails({ locale }: { locale: Locale }) {
  const empty = (await getTranslations({ locale, namespace: "home" }))("productsEmpty");
  const [popularAll, fresh] = await Promise.all([loadFeatured("popular", 16), loadFeatured("new", 8)]);
  const popular = popularAll.slice(0, 8);
  const trending = popularAll.length > 8 ? popularAll.slice(8, 16) : popularAll.slice(0, 8);
  const ratings = await loadRatings([...popular, ...trending, ...fresh].map((l) => l.id));
  return <RailSwitcher panels={{ popular: <Cards items={popular} ratings={ratings} priority locale={locale} empty={empty} />, trending: <Cards items={trending} ratings={ratings} locale={locale} empty={empty} />, new: <Cards items={fresh} ratings={ratings} locale={locale} empty={empty} /> }} />;
}

export function PopularRailSkeleton() {
  return (
    <ul className="-mx-4 flex gap-3 overflow-hidden px-4 sm:mx-0 sm:grid sm:grid-cols-3 sm:px-0 md:grid-cols-4 xl:grid-cols-8" aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <li key={i} className="w-40 shrink-0 sm:w-auto">
          <ProductCardSkeleton />
        </li>
      ))}
    </ul>
  );
}
