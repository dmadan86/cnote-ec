import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ShieldCheck } from "lucide-react";
import { buttonClasses, Chip, Container, EmptyState, Grid, LinkTabs } from "@cnote/ui";
import { localizePath, type Locale } from "@/i18n/config";
import { LocaleLink as Link } from "@/i18n/link";
import { resolveLocale } from "@/i18n/server";
import { ListingCard, SellerTile } from "@/features/search/cards";
import { JsonLd } from "@/lib/json-ld";
import { itemListLd } from "@/lib/schema";
import { selfAlternates } from "@/lib/seo-i18n";
import { loadCategories, loadHits, loadRatings, loadSellers } from "@/features/search/data";
import { firstParam } from "@/features/search/format";
import { mergeSponsored } from "@cnote/ads";
import { loadSponsoredForResults } from "@/features/ads/slots";
import { SponsoredBlock, SponsoredCard } from "@/features/ads/sponsored";
import { loadOffers } from "@/features/promotions/data";
import { SearchTools } from "@/features/search/search-tools";

// Free-text search results are a dynamic, unbounded URL space: crawlable (follow) but never indexed. The curated,
// indexable equivalents are the category pages (/c/<slug>) and keyword landing pages (/s/<category>/<keyword>).
export async function generateMetadata(props: PageProps<"/[locale]/search">): Promise<Metadata> {
  const locale = await resolveLocale(props.params);
  const t = await getTranslations({ locale, namespace: "search" });
  const q = firstParam((await props.searchParams).q);
  return {
    title: q ? t("metaTitleQuery", { q }) : t("title"),
    description: t("metaDescription"),
    alternates: selfAlternates("/search", locale),
    robots: { index: false, follow: true },
  };
}

const COMING = new Set(["templates", "services"]);

function href(params: Record<string, string>) {
  const sp = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  const s = sp.toString();
  return s ? `/search?${s}` : "/search";
}

export default async function SearchPage(props: PageProps<"/[locale]/search">) {
  const locale = await resolveLocale(props.params);
  const t = await getTranslations({ locale, namespace: "search" });
  const tm = await getTranslations({ locale, namespace: "meta" });
  const sp = await props.searchParams;
  const q = firstParam(sp.q);
  const category = firstParam(sp.category);
  const tab = firstParam(sp.tab) || "products";
  const viaPhoto = firstParam(sp.via) === "photo" && !!q;
  const isSellers = tab === "manufacturers";

  const tabs = [
    { id: "products", label: tab === "ai" ? t("tabAi") : t("tabProducts") },
    { id: "manufacturers", label: t("tabManufacturers") },
  ];

  let body: React.ReactNode;
  let count: number | null = null;

  if (COMING.has(tab)) {
    body = (
      <EmptyState
        title={t("comingTitle")}
        description={t("comingText")}
        action={
          <Link href={href({ q, tab: "products" })} className={buttonClasses("primary")}>
            {t("searchProducts")}
          </Link>
        }
      />
    );
  } else if (isSellers) {
    const sellers = await loadSellers({ q: q || undefined, limit: 24 });
    count = sellers.length;
    body = sellers.length ? (
      <><h2 className="sr-only">{t("supplierResults")}</h2>
      <Grid cols={3} className="grid-cols-1 sm:grid-cols-2">
        {sellers.map((s) => (
          <SellerTile key={s.businessId} seller={s} locale={locale} />
        ))}
      </Grid></>
    ) : (
      <NoResults q={q} locale={locale} />
    );
  } else {
    const [{ hits, failed }, categories] = await Promise.all([loadHits({ q, categorySlug: category || undefined, limit: 24 }), loadCategories()]);
    count = hits.length;
    const [ratings, offers] = await Promise.all([loadRatings(hits.map((h) => h.listing.id)), loadOffers(hits.map((h) => h.listing.id))]);
    // Sponsored slots are decided per request AFTER (and outside) the cached organic ranking: organic order is never touched
    // (ADR-024 rule 1). Off unless ADS_ENABLED; any failure or timeout yields no ads and the page renders as before.
    const categoryId = category ? categories.find((c) => c.slug === category)?.id : undefined;
    const sponsored = q || categoryId ? await loadSponsoredForResults({ query: q, categoryId, surface: categoryId ? "category" : "search", organicListingIds: hits.map((h) => h.listing.id) }) : [];
    const merged = mergeSponsored(hits.map((h) => ({ id: h.listing.id, hit: h })), sponsored.map((s) => ({ id: s.listing.id, after: s.after, slot: s })));
    body = (
      <>
        {hits.length ? <JsonLd data={itemListLd(q ? t("itemListQuery", { q }) : t("itemListProducts"), hits.map((h) => h.listing), locale)} /> : null}
        {categories.length ? (
          <ul className="-mx-4 mb-5 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0" aria-label={t("filterByCategory")}>
            <li>
              <Chip href={href({ q, tab })} linkComponent={Link} selected={!category}>
                {t("allCategories")}
              </Chip>
            </li>
            {categories.map((c) => (
              <li key={c.id} className="shrink-0">
                <Chip href={href({ q, tab, category: c.slug })} linkComponent={Link} selected={category === c.slug}>
                  {c.name}
                </Chip>
              </li>
            ))}
          </ul>
        ) : null}
        {hits.length ? (
          <>
          <SponsoredBlock slots={merged.top.map((a) => a.slot)} locale={locale} />
          <h2 className="sr-only">{t("productResults")}</h2>
          <Grid>
            {merged.feed.map((f, i) =>
              f.kind === "organic" ? (
                <ListingCard key={f.item.id} listing={f.item.hit.listing} seller={f.item.hit.seller} rating={ratings[f.item.id]} offer={offers[f.item.id]} priority={i < 4} locale={locale} />
              ) : (
                <SponsoredCard key={f.item.slot.clickToken} slot={f.item.slot} locale={locale} />
              ),
            )}
          </Grid>
          </>
        ) : (
          <NoResults q={q} failed={failed} locale={locale} />
        )}
      </>
    );
  }

  return (
    <Container className="py-6 lg:py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-ink">{q ? t("titleQuery", { q }) : t("title")}</h1>
        {count !== null ? (
          <p className="text-sm text-muted" role="status" aria-live="polite">
            {t("resultCount", { count })}
          </p>
        ) : null}
      </div>
      {viaPhoto ? <PhotoQuery q={q} tab={tab} category={category} locale={locale} /> : null}
      <form action={localizePath("/search", locale)} method="get" role="search" className="mt-4 flex flex-wrap gap-2">
        <input type="hidden" name="tab" value={tab} />
        {category ? <input type="hidden" name="category" value={category} /> : null}
        <label htmlFor="search-q" className="sr-only">
          {t("submit")}
        </label>
        <input
          id="search-q"
          name="q"
          type="search"
          defaultValue={q}
          placeholder={t("phAi")}
          className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
        />
        <SearchTools inputId="search-q" />
        <button type="submit" className={buttonClasses("primary", "md", "h-11 rounded-lg px-5")}>
          {t("submit")}
        </button>
      </form>
      <LinkTabs
        className="mt-4 border-b border-line"
        variant="underline"
        label={t("tabsAria")}
        linkComponent={Link}
        items={tabs.map((x) => ({ href: href({ q, tab: x.id, category: x.id === "products" ? category : "" }), label: x.label, active: (x.id === "products" && !isSellers && !COMING.has(tab)) || x.id === tab }))}
      />
      <p className="mt-4 flex items-start gap-2 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-900">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
        {tm("rankingPromise")}
      </p>
      <div className="mt-6">{body}</div>
    </Container>
  );
}

/**
 * "Results for photo: <derived query>" with an edit affordance. A plain GET form, so it works without JS: editing the words
 * re-runs an ordinary text search (via=photo is dropped once the words are the buyer's own).
 */
async function PhotoQuery({ q, tab, category, locale }: { q: string; tab: string; category: string; locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "search" });
  return (
    <section aria-labelledby="photo-q-title" className="mt-4 rounded-lg border border-brand-100 bg-brand-50 p-3">
      <h2 id="photo-q-title" className="text-sm font-semibold text-brand-900">{t("photoResultsFor", { q })}</h2>
      <p className="mt-1 text-sm text-brand-900">{t("photoNote")}</p>
      <form action={localizePath("/search", locale)} method="get" className="mt-2 flex gap-2">
        <input type="hidden" name="tab" value={tab} />
        {category ? <input type="hidden" name="category" value={category} /> : null}
        <label htmlFor="photo-q" className="sr-only">{t("photoEditLabel")}</label>
        <input id="photo-q" name="q" type="search" defaultValue={q} className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100" />
        <button type="submit" className={buttonClasses("outline-brand", "md", "h-11 rounded-lg px-4")}>{t("photoEditSubmit")}</button>
      </form>
    </section>
  );
}

async function NoResults({ q, failed, locale }: { q: string; failed?: boolean; locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "search" });
  return (
    <EmptyState
      title={failed ? t("failedTitle") : q ? t("noResultsTitle", { q }) : t("noProductsTitle")}
      description={failed ? t("failedText") : t("noResultsText")}
      action={
        <Link href={`/rfq/new${q ? `?q=${encodeURIComponent(q)}` : ""}`} className={buttonClasses("accent")}>
          {t("postRequirement")}
        </Link>
      }
    />
  );
}
