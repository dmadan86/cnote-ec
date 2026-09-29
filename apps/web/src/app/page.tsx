import { Suspense } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Container, SectionHeader } from "@cnote/ui";
import { CategoryGrid, CategoryGridSkeleton } from "@/features/shell/home/category-grid";
import { Hero } from "@/features/shell/home/hero";
import { PopularRail, PopularRailSkeleton, RailTabs, parseRail } from "@/features/shell/home/popular-products";
import { PromoPanels } from "@/features/shell/home/promo-panels";
import { firstParam } from "@/features/search/format";
import { loadSuggestions } from "@/features/search/data";

const FALLBACK_SUGGESTIONS = [
  "Packaging boxes for cosmetics",
  "T-shirts manufacturers in India",
  "Custom Diwali gift items",
  "Office furniture suppliers",
  "Logo design for my brand",
];

export default async function Home(props: PageProps<"/">) {
  const sp = await props.searchParams;
  const rail = parseRail(firstParam(sp.rail));
  const suggestions = await loadSuggestions(FALLBACK_SUGGESTIONS);

  return (
    <>
      <Hero suggestions={suggestions} />
      <Container className="flex flex-col gap-10 pt-8 lg:gap-14 lg:pt-10">
        <section aria-labelledby="cat-title">
          <SectionHeader
            id="cat-title"
            title="Shop by Category"
            action={
              <Link href="/categories" className="inline-flex items-center gap-1 text-brand-700 hover:underline">
                View all categories <ArrowRight className="size-4" aria-hidden />
              </Link>
            }
          />
          <Suspense fallback={<CategoryGridSkeleton />}>
            <CategoryGrid />
          </Suspense>
        </section>

        <PromoPanels />

        <section id="popular" aria-labelledby="popular-title">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
              <h2 id="popular-title" className="text-xl font-bold tracking-tight text-ink sm:text-[22px]">
                Popular Products
              </h2>
              <RailTabs active={rail} />
            </div>
            <Link href="/search?tab=products" className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline">
              View all products <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
          <Suspense key={rail} fallback={<PopularRailSkeleton />}>
            <PopularRail rail={rail} />
          </Suspense>
        </section>
      </Container>
    </>
  );
}
