import { ArrowRight, LayoutGrid } from "lucide-react";
import Link from "next/link";
import { Skeleton } from "@cnote/ui";
import { CategoryIcon } from "@/features/search/category-icon";
import { loadCategories } from "@/features/search/data";

const TINTS = ["bg-amber-50 text-amber-700", "bg-rose-50 text-rose-700", "bg-sky-50 text-sky-700", "bg-orange-50 text-orange-700", "bg-slate-100 text-slate-700", "bg-brand-50 text-brand-700"];
const TILE = "flex h-full min-h-28 w-24 shrink-0 flex-col items-center justify-center gap-2 rounded-card border border-line bg-surface p-2 text-center text-xs font-medium leading-tight text-ink transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-brand-600 md:w-auto";

export async function CategoryGrid() {
  const categories = (await loadCategories()).slice(0, 12);
  if (!categories.length) {
    return <p className="rounded-card border border-dashed border-line bg-surface px-4 py-8 text-center text-sm text-muted">Categories are being set up. Check back shortly.</p>;
  }
  return (
    <ul className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] md:mx-0 md:grid md:grid-cols-5 md:overflow-visible md:px-0 lg:grid-cols-7 xl:grid-cols-[repeat(13,minmax(0,1fr))]">
      {categories.map((c, i) => (
        <li key={c.id} className="md:w-auto">
          <Link href={`/c/${c.slug}`} className={TILE}>
            <span className={`inline-flex size-11 items-center justify-center rounded-full ${TINTS[i % TINTS.length]}`}>
              <CategoryIcon name={c.icon} className="size-6" />
            </span>
            <span className="line-clamp-2">{c.name}</span>
          </Link>
        </li>
      ))}
      <li className="md:w-auto">
        <Link href="/categories" className={TILE}>
          <span className="inline-flex size-11 items-center justify-center rounded-full bg-brand-50 text-brand-700">
            <LayoutGrid className="size-6" aria-hidden />
          </span>
          <span className="inline-flex items-center gap-1">
            More Categories <ArrowRight className="size-3" aria-hidden />
          </span>
        </Link>
      </li>
    </ul>
  );
}

export function CategoryGridSkeleton() {
  return (
    <div className="-mx-4 flex gap-3 overflow-hidden px-4 md:mx-0 md:grid md:grid-cols-5 md:px-0 lg:grid-cols-7 xl:grid-cols-[repeat(13,minmax(0,1fr))]" aria-hidden>
      {Array.from({ length: 13 }, (_, i) => (
        <Skeleton key={i} className="h-28 w-24 shrink-0 md:w-auto" />
      ))}
    </div>
  );
}
