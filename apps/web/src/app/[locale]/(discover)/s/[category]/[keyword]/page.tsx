import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Breadcrumbs, Container, Grid } from "@cnote/ui";
import { localizePath } from "@/i18n/config";
import { LocaleLink as Link } from "@/i18n/link";
import { resolveLocale } from "@/i18n/server";
import { JsonLd } from "@/lib/json-ld";
import { categoryPath, landingPath, slugify } from "@/lib/paths";
import { breadcrumbLd, itemListLd } from "@/lib/schema";
import { localizedAlternates } from "@/lib/seo-i18n";
import { ListingCard } from "@/features/search/cards";
import { loadCategory, loadHitsStatic, loadLandingKeywords, loadRatings } from "@/features/search/data";
import { getUiLabels } from "@/features/search/labels";

// Curated, indexable search landing pages: /s/<category-slug>/<keyword-slug>. Only keywords derived from live listings
// exist (allow-list); everything else 404s. Free-text /search?q= pages stay noindex. The keyword is catalogue data
// (English), so it is shown as-is in every locale; only the surrounding copy is translated.
export const revalidate = 600;

async function resolve(categorySlug: string, keywordSlug: string) {
  const [category, keywords] = await Promise.all([loadCategory(categorySlug), loadLandingKeywords()]);
  const keyword = (keywords[categorySlug] ?? []).find((k) => slugify(k, 50) === keywordSlug);
  return category && !category.prohibited && keyword ? { category, keyword } : null;
}

export async function generateStaticParams() {
  const keywords = await loadLandingKeywords();
  return Object.entries(keywords).flatMap(([category, list]) => list.slice(0, 4).map((k) => ({ category, keyword: slugify(k, 50) })));
}

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export async function generateMetadata(props: PageProps<"/[locale]/s/[category]/[keyword]">): Promise<Metadata> {
  const locale = await resolveLocale(props.params);
  const { category, keyword } = await props.params;
  const t = await getTranslations({ locale, namespace: "landing" });
  const r = await resolve(category, keyword);
  if (!r) return { title: t("notFound"), robots: { index: false, follow: false } };
  const title = t("title", { keyword: titleCase(r.keyword) });
  const description = t("description", { keyword: r.keyword, category: r.category.name.toLowerCase() });
  const alternates = localizedAlternates(landingPath(category, r.keyword), locale);
  return { title, description, alternates, openGraph: { title, description, type: "website", url: alternates.canonical } };
}

export default async function LandingPage(props: PageProps<"/[locale]/s/[category]/[keyword]">) {
  const locale = await resolveLocale(props.params);
  const { category: categorySlug, keyword: keywordSlug } = await props.params;
  const t = await getTranslations({ locale, namespace: "landing" });
  const ui = await getUiLabels(locale);
  const r = await resolve(categorySlug, keywordSlug);
  if (!r) notFound();
  const { hits } = await loadHitsStatic({ q: r.keyword, categorySlug, limit: 24 });
  const ratings = await loadRatings(hits.map((h) => h.listing.id));
  const heading = titleCase(r.keyword);
  return (
    <Container className="py-6 lg:py-8">
      <JsonLd
        data={[
          breadcrumbLd([{ name: ui.home, path: localizePath("/", locale) }, { name: r.category.name, path: localizePath(categoryPath(categorySlug), locale) }, { name: heading }]),
          itemListLd(heading, hits.map((h) => h.listing), locale),
        ]}
      />
      <Breadcrumbs linkComponent={Link} label={ui.breadcrumb} items={[{ label: ui.home, href: "/" }, { label: r.category.name, href: categoryPath(categorySlug) }, { label: heading }]} />
      <h1 className="mt-4 text-2xl font-bold tracking-tight text-ink">{t("heading", { keyword: heading })}</h1>
      <p className="mt-1 text-sm text-muted">{t("intro", { keyword: r.keyword, category: r.category.name })}</p>
      <div className="mt-6">
        <h2 className="sr-only">{t("products")}</h2>
        <Grid>
          {hits.map((h, i) => (
            <ListingCard key={h.listing.id} listing={h.listing} seller={h.seller} rating={ratings[h.listing.id]} priority={i < 4} locale={locale} />
          ))}
        </Grid>
      </div>
    </Container>
  );
}
