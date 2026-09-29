import Link from "next/link";
import { LinkTabs, ProductCardSkeleton, Rail } from "@cnote/ui";
import type { ListingView } from "@cnote/catalogue";
import { ListingCard } from "@/features/search/cards";
import { loadFeatured } from "@/features/search/data";

export const RAILS = [
  { id: "business", label: "For Your Business" },
  { id: "trending", label: "Trending" },
  { id: "new", label: "New Arrivals" },
  { id: "best", label: "Best Selling" },
] as const;
export type RailId = (typeof RAILS)[number]["id"];

export function parseRail(v: string | undefined): RailId {
  return RAILS.some((r) => r.id === v) ? (v as RailId) : "business";
}

export function RailTabs({ active }: { active: RailId }) {
  return (
    <LinkTabs
      label="Popular products"
      linkComponent={Link}
      items={RAILS.map((r) => ({ href: r.id === "business" ? "/#popular" : `/?rail=${r.id}#popular`, label: r.label, active: r.id === active }))}
    />
  );
}

/**
 * Rail → data mapping (Phase 1 has no per-buyer personalisation or sales counters):
 * business/best → catalogue "popular"; trending → the next window of "popular"; new → "new".
 */
export async function PopularRail({ rail }: { rail: RailId }) {
  const items: ListingView[] =
    rail === "new" ? await loadFeatured("new", 8) : await loadFeatured("popular", 16).then((all) => (rail === "trending" && all.length > 8 ? all.slice(8, 16) : all.slice(0, 8)));
  if (!items.length) {
    return <p className="rounded-card border border-dashed border-line bg-surface px-4 py-10 text-center text-sm text-muted">Products will show up here as suppliers publish listings.</p>;
  }
  return (
    <Rail className="md:grid-cols-4 xl:grid-cols-8">
      {items.map((l, i) => (
        <ListingCard key={l.id} listing={l} priority={i < 2} />
      ))}
    </Rail>
  );
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
