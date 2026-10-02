import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ShieldCheck } from "lucide-react";
import { buttonClasses, Container, EmptyState, Grid, LinkTabs } from "@cnote/ui";
import { localizePath, type Locale } from "@/i18n/config";
import { LocaleLink as Link } from "@/i18n/link";
import { resolveLocale } from "@/i18n/server";
import { ListingCard, SellerTile } from "@/features/search/cards";
import { JsonLd } from "@/lib/json-ld";
import { itemListLd } from "@/lib/schema";
import { selfAlternates } from "@/lib/seo-i18n";
import { loadCategories, loadHits, loadRatings, loadSellers } from "@/features/search/data";
import { firstParam } from "@/features/search/format";
import { EMPTY_FILTERS, hasFilters, hrefFor, parseFilterState, toSearchArgs, toSearchParams, type FilterState } from "@/features/search/filter-state";
import { FilterShell } from "@/features/search/filter-shell";
import { filterSellers, sellerFacets, sortSellers } from "@/features/search/seller-filters";

import { mergeSponsored } from "@cnote/ads";
import { loadSponsoredForResults } from "@/features/ads/slots";
import { SponsoredBlock, SponsoredCard } from "@/features/ads/sponsored";
import { loadOffers } from "@/features/promotions/data";
import { SearchTools } from "@/features/search/search-tools";
import { SaveSearch } from "@/features/retention/save-search";

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

export default async function SearchPage(props: PageProps<"/[locale]/search">) {
  const locale = await resolveLocale(props.params);
  const t = await getTranslations({ locale, namespace: "search" });
  const tm = await getTranslations({ locale, namespace: "meta" });
  const sp = await props.searchParams;
  const q = firstParam(sp.q);
  const tab = firstParam(sp.tab) || "products";
  const viaPhoto = firstParam(sp.via) === "photo" && !!q;
  const isSellers = tab === "manufacturers";
  const state = parseFilterState(sp);
  const category = state.categories[0] ?? "";
  const base = { q: q || undefined, tab };
  // "Save this search" (docs/design/buyer-retention.md): products only, and only when there is something to save.
  const saveArgs = toSearchArgs(state);
  const canSave = !isSellers && !COMING.has(tab) && (!!q || hasFilters(state));

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
          <Link href={hrefFor("/search", { q: q || undefined }, EMPTY_FILTERS)} className={buttonClasses("primary")}>
            {t("searchProducts")}
          </Link>
        }
      />
    );
  } else if (isSellers) {
    // Suppliers: tier / state / city only (price, MOQ and category describe listings, not suppliers).
    const sstate: FilterState = { ...state, categories: [], pmin: null, pmax: null, moq: null, priced: false, sort: state.sort === "trust" ? "trust" : "relevance" };
    const all = await loadSellers({ q: q || undefined, limit: 100 });
    const sellers = sortSellers(filterSellers(all, sstate), sstate.sort).slice(0, 24);
    count = sellers.length;
    body = (
      <FilterShell locale={locale} kind="sellers" path="/search" base={base} state={sstate} facets={sellerFacets(all, sstate)} showCategories={false} categoryNames={{}}>
        {sellers.length ? (
          <>
            <h2 className="sr-only">{t("supplierResults")}</h2>
            <Grid cols={3} className="grid-cols-1 sm:grid-cols-2">
              {sellers.map((s) => (
                <SellerTile key={s.businessId} seller={s} locale={locale} />
              ))}
            </Grid>
          </>
        ) : (
          <NoResults q={q} locale={locale} filtered={hasFilters(sstate)} clearHref={hrefFor("/search", base, { ...EMPTY_FILTERS, sort: sstate.sort })} />
        )}
      </FilterShell>
    );
  } else {
    const args = toSearchArgs(state);
    const [{ hits, failed, facets }, categories] = await Promise.all([loadHits({ q, limit: 24, filters: args.filters, sort: args.sort }), loadCategories()]);
    count = hits.length;
    const [ratings, offers] = await Promise.all([loadRatings(hits.map((h) => h.listing.id)), loadOffers(hits.map((h) => h.listing.id))]);
    // Sponsored slots are decided per request AFTER (and outside) the cached organic ranking: organic order is never touched
    // (ADR-024 rule 1). Off unless ADS_ENABLED; any failure or timeout yields no ads and the page renders as before.
    const categoryId = category ? categories.find((c) => c.slug === category)?.id : undefined;
    const sponsored = q || categoryId ? await loadSponsoredForResults({ query: q, categoryId, surface: categoryId ? "category" : "search", organicListingIds: hits.map((h) => h.listing.id) }) : [];
    const merged = mergeSponsored(hits.map((h) => ({ id: h.listing.id, hit: h })), sponsored.map((s) => ({ id: s.listing.id, after: s.after, slot: s })));
    const categoryNames = Object.fromEntries(categories.map((c) => [c.slug, c.name]));
    // Without facet counts (a backend that returns none) the category list still offers every category, uncounted.
    const panelFacets = facets ?? { category: categories.map((c) => ({ key: c.slug, count: 0 })) };
    body = (
      <FilterShell locale={locale} kind="products" path="/search" base={base} state={state} facets={panelFacets} showCategories categoryNames={categoryNames}>
        {hits.length ? <JsonLd data={itemListLd(q ? t("itemListQuery", { q }) : t("itemListProducts"), hits.map((h) => h.listing), locale)} /> : null}
        {hits.length ? (
          <>
          <SponsoredBlock slots={merged.top.map((a) => a.slot)} locale={locale} />
          <h2 className="sr-only">{t("productResults")}</h2>
          <Grid className="lg:grid-cols-3 xl:grid-cols-4">
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
          <NoResults q={q} failed={failed} locale={locale} filtered={hasFilters(state)} clearHref={hrefFor("/search", base, { ...EMPTY_FILTERS, sort: state.sort })} />
        )}
      </FilterShell>
    );
  }

  return (
    <Container className="py-6 lg:py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight text-ink">{q ? t("titleQuery", { q }) : t("title")}</h1>
          {count !== null ? (
            <p className="text-sm text-muted" role="status" aria-live="polite">
              {t("resultCount", { count })}
            </p>
          ) : null}
        </div>
        {canSave ? <SaveSearch q={q ?? ""} filters={saveArgs.filters} sort={saveArgs.sort} /> : null}
      </div>
      {viaPhoto ? <PhotoQuery q={q} tab={tab} state={state} locale={locale} /> : null}
      <form action={localizePath("/search", locale)} method="get" role="search" className="mt-4 flex flex-wrap gap-2">
        <input type="hidden" name="tab" value={tab} />
        <CarryFilters state={state} />
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
        items={tabs.map((x) => ({ href: hrefFor("/search", { q: q || undefined, tab: x.id }, state), label: x.label, active: (x.id === "products" && !isSellers && !COMING.has(tab)) || x.id === tab }))}
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
async function PhotoQuery({ q, tab, state, locale }: { q: string; tab: string; state: FilterState; locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "search" });
  return (
    <section aria-labelledby="photo-q-title" className="mt-4 rounded-lg border border-brand-100 bg-brand-50 p-3">
      <h2 id="photo-q-title" className="text-sm font-semibold text-brand-900">{t("photoResultsFor", { q })}</h2>
      <p className="mt-1 text-sm text-brand-900">{t("photoNote")}</p>
      <form action={localizePath("/search", locale)} method="get" className="mt-2 flex gap-2">
        <input type="hidden" name="tab" value={tab} />
        <CarryFilters state={state} />
        <label htmlFor="photo-q" className="sr-only">{t("photoEditLabel")}</label>
        <input id="photo-q" name="q" type="search" defaultValue={q} className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100" />
        <button type="submit" className={buttonClasses("outline-brand", "md", "h-11 rounded-lg px-4")}>{t("photoEditSubmit")}</button>
      </form>
    </section>
  );
}

/** The current filters as hidden fields, so searching again keeps them (q and tab are handled by the caller). */
function CarryFilters({ state }: { state: FilterState }) {
  return [...toSearchParams({}, state).entries()].map(([k, v], i) => <input key={`${k}-${i}`} type="hidden" name={k} value={v} />);
}

async function NoResults({ q, failed, locale, filtered, clearHref }: { q: string; failed?: boolean; locale: Locale; filtered?: boolean; clearHref?: string }) {
  const t = await getTranslations({ locale, namespace: "search" });
  const tf = await getTranslations({ locale, namespace: "filters" });
  if (filtered && !failed && clearHref) {
    return (
      <EmptyState
        title={tf("noMatch")}
        description={tf("noMatchHint")}
        action={
          <Link href={clearHref} className={buttonClasses("primary")}>
            {tf("clearAll")}
          </Link>
        }
      />
    );
  }
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
