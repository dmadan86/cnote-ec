import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { buttonClasses, Container, EmptyState, Grid, Input, Pagination } from "@cnote/ui";
import { localizePath } from "@/i18n/config";
import { LocaleLink as Link } from "@/i18n/link";
import { resolveLocale } from "@/i18n/server";
import { SellerTile } from "@/features/search/cards";
import { getUiLabels } from "@/features/search/labels";
import { JsonLd } from "@/lib/json-ld";
import { sellerPath } from "@/lib/paths";
import { localizedAlternates, selfAlternates } from "@/lib/seo-i18n";
import { absoluteUrl } from "@/lib/site-url";
import { loadSellers } from "@/features/search/data";
import { firstParam, pageParam } from "@/features/search/format";

export async function generateMetadata(props: PageProps<"/[locale]/manufacturers">): Promise<Metadata> {
  const locale = await resolveLocale(props.params);
  const t = await getTranslations({ locale, namespace: "manufacturers" });
  const sp = await props.searchParams;
  const filtered = !!(firstParam(sp.q) || firstParam(sp.city));
  const page = pageParam(sp.page);
  const base = localizedAlternates("/manufacturers", locale);
  return {
    title: t("title"),
    description: t("description"),
    // Filtered views are crawlable (noindex,follow) but consolidate to the unfiltered listing.
    alternates: page > 1 && !filtered ? selfAlternates(`/manufacturers?page=${page}`, locale) : base,
    robots: filtered ? { index: false, follow: true } : undefined,
    openGraph: { title: t("title"), description: t("description"), url: base.canonical },
  };
}
const PAGE_SIZE = 24;

export default async function ManufacturersPage(props: PageProps<"/[locale]/manufacturers">) {
  const locale = await resolveLocale(props.params);
  const t = await getTranslations({ locale, namespace: "manufacturers" });
  const ts = await getTranslations({ locale, namespace: "search" });
  const ui = await getUiLabels(locale);
  const sp = await props.searchParams;
  const q = firstParam(sp.q);
  const city = firstParam(sp.city);
  const page = pageParam(sp.page);
  const rows = await loadSellers({ q: q || undefined, city: city || undefined, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE });
  const sellers = rows.slice(0, PAGE_SIZE);
  const hrefFor = (p: number) => {
    const s = new URLSearchParams();
    if (q) s.set("q", q);
    if (city) s.set("city", city);
    if (p > 1) s.set("page", String(p));
    return `/manufacturers${s.size ? `?${s}` : ""}`;
  };

  return (
    <Container className="py-6 lg:py-8">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "ItemList",
          name: t("title"),
          itemListElement: sellers.map((s, i) => ({ "@type": "ListItem", position: i + 1, url: absoluteUrl(localizePath(sellerPath(s.businessId), locale)), name: s.name })),
        }}
      />
      <h1 className="text-2xl font-bold tracking-tight text-ink">{t("title")}</h1>
      <p className="mt-1 text-sm text-muted">{t("intro")}</p>
      <form action={localizePath("/manufacturers", locale)} method="get" role="search" className="mt-5 grid gap-2 sm:grid-cols-[1fr_14rem_auto]">
        <label className="sr-only" htmlFor="m-q">{t("nameOrProduct")}</label>
        <Input id="m-q" name="q" type="search" defaultValue={q} placeholder={t("nameOrProduct")} className="h-11" />
        <label className="sr-only" htmlFor="m-city">{t("city")}</label>
        <Input id="m-city" name="city" defaultValue={city} placeholder={t("cityPlaceholder")} className="h-11" />
        <button type="submit" className={buttonClasses("primary", "md", "h-11 rounded-lg px-5")}>{t("filter")}</button>
      </form>
      <div className="mt-6">
        {sellers.length ? (
          <>
            <h2 className="sr-only">{t("suppliers")}</h2>
            <Grid cols={3} className="grid-cols-1 sm:grid-cols-2">
              {sellers.map((s) => (
                <SellerTile key={s.businessId} seller={s} locale={locale} />
              ))}
            </Grid>
            <Pagination className="mt-8" page={page} hasNext={rows.length > PAGE_SIZE} hrefFor={hrefFor} linkComponent={Link} labels={ui.pagination} />
          </>
        ) : (
          <EmptyState
            title={t("emptyTitle")}
            description={t("emptyText")}
            action={<Link href={`/rfq/new${q ? `?q=${encodeURIComponent(q)}` : ""}`} className={buttonClasses("accent")}>{ts("postRequirement")}</Link>}
          />
        )}
      </div>
    </Container>
  );
}
