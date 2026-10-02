import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Breadcrumbs, buttonClasses, Container, EmptyState, Grid } from "@cnote/ui";
import { localizePath } from "@/i18n/config";
import { LocaleLink as Link } from "@/i18n/link";
import { resolveLocale } from "@/i18n/server";
import { JsonLd } from "@/lib/json-ld";
import { breadcrumbLd, itemListLd } from "@/lib/schema";
import { categoryPath } from "@/lib/paths";
import { localizedAlternates } from "@/lib/seo-i18n";
import { ListingCard } from "@/features/search/cards";
import { loadCategories, loadCategory, loadHitsStatic, loadRatings } from "@/features/search/data";
import { EMPTY_FILTERS } from "@/features/search/filter-state";
import { FilterShell } from "@/features/search/filter-shell";
import { getUiLabels } from "@/features/search/labels";
import { loadOffers } from "@/features/promotions/data";

// Category landing pages: prerendered for every category at build time, rebuilt in the background every 5 min and on
// demand when `search` / `category:<slug>` / listing tags are purged. Unknown slugs render on first request (ISR).
export const revalidate = 300;

export async function generateStaticParams() {
  return (await loadCategories()).map((c) => ({ slug: c.slug }));
}

export async function generateMetadata(props: PageProps<"/[locale]/c/[slug]">): Promise<Metadata> {
  const locale = await resolveLocale(props.params);
  const { slug } = await props.params;
  const t = await getTranslations({ locale, namespace: "category" });
  const c = await loadCategory(slug);
  if (!c || c.prohibited) return { title: t("notFound"), robots: { index: false, follow: false } };
  const title = t("title", { name: c.name });
  const description = t("description", { name: c.name.toLowerCase() });
  const alternates = localizedAlternates(categoryPath(slug), locale);
  return {
    title,
    description,
    alternates,
    openGraph: { title, description, type: "website", url: alternates.canonical },
    twitter: { card: "summary", title, description },
  };
}

export default async function CategoryPage(props: PageProps<"/[locale]/c/[slug]">) {
  const locale = await resolveLocale(props.params);
  const { slug } = await props.params;
  const t = await getTranslations({ locale, namespace: "category" });
  const ts = await getTranslations({ locale, namespace: "search" });
  const ui = await getUiLabels(locale);
  const category = await loadCategory(slug);
  if (!category || category.prohibited) notFound();
  const { hits, facets } = await loadHitsStatic({ q: "", categorySlug: slug, limit: 48 });
  const [ratings, offers] = await Promise.all([loadRatings(hits.map((h) => h.listing.id)), loadOffers(hits.map((h) => h.listing.id))]);
  const catsPath = localizePath("/categories", locale);
  const catsName = (await getTranslations({ locale, namespace: "categories" }))("title");
  return (
    <Container className="py-6 lg:py-8">
      <JsonLd
        data={[
          breadcrumbLd([{ name: ui.home, path: localizePath("/", locale) }, { name: catsName, path: catsPath }, { name: category.name }]),
          itemListLd(t("productsListName", { name: category.name }), hits.map((h) => h.listing), locale),
        ]}
      />
      <Breadcrumbs linkComponent={Link} label={ui.breadcrumb} items={[{ label: ui.home, href: "/" }, { label: catsName, href: "/categories" }, { label: category.name }]} />
      <h1 className="mt-4 text-2xl font-bold tracking-tight text-ink">{category.name}</h1>
      <p className="mt-1 text-sm text-muted">
        {hits.length ? t("productCount", { count: hits.length }) : ""}
        {(await getTranslations({ locale, namespace: "meta" }))("rankingPromise")}
      </p>
      {/* Static (ISR) page: it takes no query string. The filter form and sort submit to /search?category=<slug>&..., which renders the
          same sidebar with the chosen state. Facet counts are the unfiltered ones, cached with the hits. */}
      <FilterShell locale={locale} kind="products" path="/search" base={{}} state={{ ...EMPTY_FILTERS, categories: [slug] }} facets={facets} showCategories={false} categoryNames={{ [slug]: category.name }}>
        {hits.length ? (
          <>
            <h2 className="sr-only">{t("productsIn", { name: category.name })}</h2>
            <Grid className="lg:grid-cols-3 xl:grid-cols-4">
              {hits.map((h, i) => (
                <ListingCard key={h.listing.id} listing={h.listing} seller={h.seller} rating={ratings[h.listing.id]} offer={offers[h.listing.id]} priority={i < 4} locale={locale} />
              ))}
            </Grid>
          </>
        ) : (
          <EmptyState
            title={t("emptyTitle")}
            description={t("emptyText")}
            action={
              <Link href={`/rfq/new?q=${encodeURIComponent(category.name)}`} className={buttonClasses("accent")}>
                {ts("postRequirement")}
              </Link>
            }
          />
        )}
      </FilterShell>
    </Container>
  );
}
