import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Container, SectionHeader } from "@cnote/ui";
import { JsonLd } from "@/lib/json-ld";
import { absoluteUrl, SITE_ORIGIN } from "@/lib/site-url";
import { CategoryGrid, CategoryGridSkeleton } from "@/features/shell/home/category-grid";
import { Hero } from "@/features/shell/home/hero";
import { PopularRails, PopularRailSkeleton } from "@/features/shell/home/popular-products";
import { PromoPanels } from "@/features/shell/home/promo-panels";
import { SITE_NAME, SITE_TAGLINE } from "@/features/shell/site";
import { loadSuggestions } from "@/features/search/data";

// Static + ISR: rebuilt in the background at most every 5 minutes, and on demand when cache tags are purged
// (POST /api/revalidate, fed by ListingPublished/Moderated/Archived, TrustScoreChanged, ... events).
export const revalidate = 300;

export const metadata: Metadata = {
  title: { absolute: `${SITE_NAME} · ${SITE_TAGLINE}` },
  alternates: { canonical: "/" },
};

const FALLBACK_SUGGESTIONS = [
  "Packaging boxes for cosmetics",
  "T-shirts manufacturers in India",
  "Custom Diwali gift items",
  "Office furniture suppliers",
  "Logo design for my brand",
];

export default async function Home() {
  const suggestions = await loadSuggestions(FALLBACK_SUGGESTIONS);

  return (
    <>
      <JsonLd
        data={[
          {
            "@context": "https://schema.org",
            "@type": "Organization",
            "@id": `${SITE_ORIGIN}/#organization`,
            name: SITE_NAME,
            url: SITE_ORIGIN,
            description: "AI-first B2B marketplace connecting Indian MSME buyers with verified manufacturers and suppliers.",
            areaServed: { "@type": "Country", name: "India" },
          },
          {
            "@context": "https://schema.org",
            "@type": "WebSite",
            "@id": `${SITE_ORIGIN}/#website`,
            url: SITE_ORIGIN,
            name: SITE_NAME,
            inLanguage: "en-IN",
            publisher: { "@id": `${SITE_ORIGIN}/#organization` },
            // Sitelinks search box.
            potentialAction: { "@type": "SearchAction", target: { "@type": "EntryPoint", urlTemplate: `${absoluteUrl("/search")}?q={search_term_string}` }, "query-input": "required name=search_term_string" },
          },
        ]}
      />
      <Hero suggestions={suggestions} />
      <Container className="flex flex-col gap-10 pt-8 lg:gap-14 lg:pt-10">
        <section aria-labelledby="cat-title">
          <SectionHeader
            id="cat-title"
            title="Shop by Category"
            action={
              <Link href="/categories" className="inline-flex min-h-11 items-center gap-1 text-brand-700 hover:underline">
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
            <h2 id="popular-title" className="text-xl font-bold tracking-tight text-ink sm:text-[22px]">
              Popular Products
            </h2>
            <Link href="/search?tab=products" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-700 hover:underline">
              View all products <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
          <Suspense fallback={<PopularRailSkeleton />}>
            <PopularRails />
          </Suspense>
        </section>
      </Container>
    </>
  );
}
