import { Suspense } from "react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ArrowRight } from "lucide-react";
import { Container, SectionHeader } from "@cnote/ui";
import { LocaleLink as Link } from "@/i18n/link";
import { localizePath } from "@/i18n/config";
import { resolveLocale } from "@/i18n/server";
import { JsonLd } from "@/lib/json-ld";
import { inLanguage, localizedAlternates } from "@/lib/seo-i18n";
import { absoluteUrl, SITE_ORIGIN } from "@/lib/site-url";
import { CategoryGrid, CategoryGridSkeleton } from "@/features/shell/home/category-grid";
import { Hero } from "@/features/shell/home/hero";
import { PopularRails, PopularRailSkeleton } from "@/features/shell/home/popular-products";
import { PromoPanels } from "@/features/shell/home/promo-panels";
import { PromoCollections, PromoHeroBanner, PromoStrip } from "@/features/promotions/home";
import { SITE_NAME } from "@/features/shell/site";
import { loadSuggestions } from "@/features/search/data";

// Static + ISR: rebuilt in the background at most every 5 minutes, and on demand when cache tags are purged
// (POST /api/revalidate, fed by ListingPublished/Moderated/Archived, TrustScoreChanged, ... events).
export const revalidate = 300;

export async function generateMetadata(props: PageProps<"/[locale]">): Promise<Metadata> {
  const locale = await resolveLocale(props.params);
  const t = await getTranslations({ locale, namespace: "meta" });
  return { title: { absolute: `${SITE_NAME} · ${t("tagline")}` }, alternates: localizedAlternates("/", locale) };
}

export default async function Home(props: PageProps<"/[locale]">) {
  const locale = await resolveLocale(props.params);
  const t = await getTranslations({ locale, namespace: "home" });
  const ts = await getTranslations({ locale, namespace: "search" });
  const tm = await getTranslations({ locale, namespace: "meta" });
  const suggestions = await loadSuggestions([1, 2, 3, 4, 5].map((n) => ts(`suggestion${n}`)));
  const homeUrl = `${SITE_ORIGIN}${localizePath("/", locale)}`;

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
            description: tm("orgDescription"),
            areaServed: { "@type": "Country", name: "India" },
          },
          {
            "@context": "https://schema.org",
            "@type": "WebSite",
            "@id": `${homeUrl}#website`,
            url: homeUrl,
            name: SITE_NAME,
            inLanguage: inLanguage(locale),
            publisher: { "@id": `${SITE_ORIGIN}/#organization` },
            // Sitelinks search box.
            potentialAction: { "@type": "SearchAction", target: { "@type": "EntryPoint", urlTemplate: `${absoluteUrl(localizePath("/search", locale))}?q={search_term_string}` }, "query-input": "required name=search_term_string" },
          },
        ]}
      />
      <Suspense fallback={null}>
        <PromoStrip locale={locale} />
      </Suspense>
      <Hero suggestions={suggestions} locale={locale} />
      <Container className="flex flex-col gap-10 pt-8 lg:gap-14 lg:pt-10">
        {/* Editorial (never sold) promotions: optional, render nothing when none are live. */}
        <Suspense fallback={null}>
          <PromoHeroBanner locale={locale} />
        </Suspense>
        <section aria-labelledby="cat-title">
          <SectionHeader
            id="cat-title"
            title={t("shopByCategory")}
            action={
              <Link href="/categories" className="inline-flex min-h-11 items-center gap-1 text-brand-700 hover:underline">
                {t("viewAllCategories")} <ArrowRight className="size-4" aria-hidden />
              </Link>
            }
          />
          <Suspense fallback={<CategoryGridSkeleton />}>
            <CategoryGrid locale={locale} />
          </Suspense>
        </section>

        <PromoPanels locale={locale} />

        <Suspense fallback={null}>
          <PromoCollections locale={locale} />
        </Suspense>

        <section id="popular" aria-labelledby="popular-title">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 id="popular-title" className="text-xl font-bold tracking-tight text-ink sm:text-[22px]">
              {t("popularProducts")}
            </h2>
            <Link href="/search?tab=products" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-700 hover:underline">
              {t("viewAllProducts")} <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
          <Suspense fallback={<PopularRailSkeleton />}>
            <PopularRails locale={locale} />
          </Suspense>
        </section>
      </Container>
    </>
  );
}
