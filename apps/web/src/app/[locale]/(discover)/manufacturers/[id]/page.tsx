import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Flag, MapPin, Store } from "lucide-react";
import { Avatar, Breadcrumbs, buttonClasses, Card, CardBody, Container, EmptyState, TrustBadge } from "@cnote/ui";
import { LOCALE_META, localizePath } from "@/i18n/config";
import { LocaleLink as Link } from "@/i18n/link";
import { resolveLocale } from "@/i18n/server";
import { JsonLd } from "@/lib/json-ld";
import { isUuid, sellerPath } from "@/lib/paths";
import { breadcrumbLd, sellerLd } from "@/lib/schema";
import { localizedAlternates } from "@/lib/seo-i18n";
import { absoluteUrl } from "@/lib/site-url";
import { ListingCard } from "@/features/search/cards";
import { loadRatings, loadSeller, loadSellerIndex, loadSellerListings } from "@/features/search/data";
import { getUiLabels } from "@/features/search/labels";
import { loadOffers } from "@/features/promotions/data";
import { stateLabel } from "@/features/identity/states";
import { UnlockButton } from "@/features/leadgen/unlock-buttons";
import { RatingStars, Stars } from "@/features/reviews/stars";
import { loadSellerReviews, loadSupplierTrust } from "@/features/supplier/data";
import { evidenceItems, responseText, yearsText } from "@/features/supplier/evidence-items";
import { FilterableProducts } from "@/features/supplier/filterable-products";
import { ProfileTabs } from "@/features/supplier/profile-tabs";
import { ShareButton } from "@/features/supplier/share-button";

// Static + ISR like product pages: top sellers prerendered, the rest on first request; purged by seller:<id> / seller-listings:<id>.
// The tab state lives in the URL hash (client side), so nothing here reads the query string or cookies.
export const revalidate = 300;

export async function generateStaticParams() {
  return (await loadSellerIndex(0, 50)).map((s) => ({ id: s.businessId }));
}

export async function generateMetadata(props: PageProps<"/[locale]/manufacturers/[id]">): Promise<Metadata> {
  const locale = await resolveLocale(props.params);
  const { id } = await props.params;
  const t = await getTranslations({ locale, namespace: "manufacturer" });
  const ui = await getUiLabels(locale);
  const s = isUuid(id) ? await loadSeller(id) : null;
  if (!s) return { title: t("notFound"), robots: { index: false, follow: false } };
  const place = [s.city, s.state].filter(Boolean).join(", ");
  const title = `${s.name}${place ? `, ${place}` : ""}`;
  const description = t("description", { name: s.name, place: place ? t("in", { place }) : "", tier: ui.tierName(s.verificationTier).toLowerCase(), score: s.trustScore });
  const alternates = localizedAlternates(sellerPath(id), locale);
  return { title, description, alternates, openGraph: { title, description, type: "profile", url: alternates.canonical }, twitter: { card: "summary", title, description } };
}

export default async function ManufacturerPage(props: PageProps<"/[locale]/manufacturers/[id]">) {
  const locale = await resolveLocale(props.params);
  const { id } = await props.params;
  const [t, tm, tp, tsh, ts] = await Promise.all(["manufacturer", "manufacturers", "product", "shell", "supplier"].map((namespace) => getTranslations({ locale, namespace })));
  const tx = ts as unknown as (k: string, v?: Record<string, string | number>) => string;
  const ui = await getUiLabels(locale);
  if (!isUuid(id)) notFound();
  const seller = await loadSeller(id);
  if (!seller) notFound();
  const listings = await loadSellerListings(id);
  const [ratings, offers, trust, reviewPage] = await Promise.all([
    loadRatings(listings.map((l) => l.id)),
    loadOffers(listings.map((l) => l.id)),
    loadSupplierTrust(id),
    loadSellerReviews(id, 10),
  ]);
  const place = [seller.city, await stateLabelFor(locale, seller.state)].filter(Boolean).join(", ");
  const bcp47 = LOCALE_META[locale].bcp47;
  const resp = trust ? responseText(trust, tx) : { time: null, accept: null };
  const items = trust ? evidenceItems(trust, tx, bcp47) : [];
  const titles = new Map(listings.map((l) => [l.id, l.title]));
  const cats = new Map<string, { id: string; name: string; count: number }>();
  for (const l of listings) cats.set(l.category.id, { id: l.category.id, name: l.category.name, count: (cats.get(l.category.id)?.count ?? 0) + 1 });
  const categories = [...cats.values()].sort((a, b) => b.count - a.count);
  const counts = new Set([listings.length, ...categories.map((c) => c.count)]);
  const showing = Object.fromEntries([...counts].map((n) => [n, tx("products.showing", { count: n })]));
  const firstListing = listings[0];
  const rating = trust?.rating ?? null;
  const reportHref = `/report?url=${encodeURIComponent(localizePath(sellerPath(id), locale))}`;

  const fact = (label: string, value: string) => (
    <div key={label}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm font-semibold text-ink">{value}</dd>
    </div>
  );

  const aboutPanel = (
    <dl className="grid max-w-3xl gap-4 sm:grid-cols-2">
      {place ? fact(tx("about.location"), place) : null}
      {trust ? fact(tx("about.memberSince"), String(trust.memberSinceYear)) : null}
      {trust ? fact(tx("about.listings"), String(trust.liveListings)) : null}
      {seller.languages.length ? fact(tx("about.languages"), seller.languages.join(", ")) : null}
      {categories.length ? fact(tx("about.categories"), categories.map((c) => c.name).join(", ")) : null}
    </dl>
  );

  const productsPanel = listings.length ? (
    <FilterableProducts
      categories={categories}
      labels={{ filter: tx("products.filterLabel"), all: tx("products.all"), showing }}
      items={listings.map((l) => ({ id: l.id, categoryId: l.category.id, node: <ListingCard listing={l} rating={ratings[l.id]} offer={offers[l.id]} locale={locale} /> }))}
    />
  ) : (
    <EmptyState
      title={t("emptyTitle")}
      description={t("emptyText")}
      action={
        <Link href={`/rfq/new?seller=${id}`} className={buttonClasses("accent")}>
          {tp("requestQuote")}
        </Link>
      }
    />
  );

  const reviewsPanel = rating ? (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
      <section aria-labelledby="rating-summary">
        <h2 id="rating-summary" className="text-base font-bold text-ink">
          {tx("reviews.summary")}
        </h2>
        <p className="mt-2 flex items-center gap-2">
          <Stars value={rating.average} className="text-xl" />
          <span className="text-sm text-ink">{tx("values.ratingValue", { average: rating.average.toFixed(1), count: rating.count })}</span>
        </p>
        <ul className="mt-3 flex flex-col gap-1.5">
          {[5, 4, 3, 2, 1].map((n) => (
            <li key={n} className="flex items-center gap-2 text-xs text-muted">
              <span className="w-28 shrink-0">{tx("reviews.starsRow", { stars: n, count: rating.histogram[n - 1]! })}</span>
              <span aria-hidden className="h-2 flex-1 overflow-hidden rounded-full bg-canvas">
                <span className="block h-full bg-accent-600" style={{ width: `${Math.round((rating.histogram[n - 1]! / rating.count) * 100)}%` }} />
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="review-list">
        <h2 id="review-list" className="sr-only">
          {tx("reviews.title")}
        </h2>
        <ul className="flex flex-col gap-4">
          {reviewPage.items.map((r) => (
            <li key={r.id} className="rounded-card border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Stars value={r.rating} className="text-sm" />
                {r.title ? <h3 className="text-sm font-semibold text-ink">{r.title}</h3> : null}
              </div>
              <p className="mt-1 text-xs text-muted">
                {r.authorName} · {new Date(r.createdAt).toLocaleDateString(bcp47, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })}
                {titles.get(r.listingId) ? ` · ${tx("reviews.forProduct", { product: titles.get(r.listingId)! })}` : ""}
                {r.verifiedEnquiry ? ` · ${tx("reviews.verifiedEnquiry")}` : ""}
              </p>
              <p className="mt-2 whitespace-pre-line text-sm text-ink/80">{r.body}</p>
              {r.sellerReply ? (
                <div className="mt-3 rounded-lg bg-canvas p-3 text-sm">
                  <p className="text-xs font-semibold text-ink">{tx("reviews.sellerReply")}</p>
                  <p className="mt-1 whitespace-pre-line text-ink/80">{r.sellerReply.body}</p>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  ) : (
    <p className="text-sm text-muted">{tx("reviews.none")}</p>
  );

  const verificationPanel = (
    <div className="max-w-3xl">
      <h2 className="text-base font-bold text-ink">{tx("verification.title")}</h2>
      <p className="mt-1 text-sm text-muted">{tx("verification.intro")}</p>
      <p className="mt-2 text-sm font-medium text-ink">{tx("verification.level", { tier: ui.tierName(seller.verificationTier) })}</p>
      <ul aria-label={tx("evidence.list")} className="mt-4 divide-y divide-line rounded-card border border-line bg-surface">
        {items.map((i) => (
          <li key={i.key} className="flex items-start gap-3 p-4">
            <span aria-hidden className="mt-0.5 text-lg leading-none">
              {i.passed ? "✓" : "–"}
            </span>
            <div>
              <p className="text-sm font-semibold text-ink">{i.label}</p>
              <p className="text-sm text-muted">{i.description}</p>
              <p className="mt-0.5 text-xs font-medium text-ink">{i.status}</p>
            </div>
          </li>
        ))}
      </ul>
      {trust?.gstinMasked ? <p className="mt-3 text-sm text-muted">{tx("evidence.gstinOnFile", { gstin: trust.gstinMasked })}</p> : null}
      <p className="mt-3 text-sm text-muted">{tx("verification.notice")}</p>
      <p className="mt-2 text-sm">
        <Link href="/trust" className="font-medium text-brand-700 underline">
          {tx("verification.explainer")}
        </Link>
      </p>
    </div>
  );

  return (
    <Container className="py-6 lg:py-8">
      <JsonLd
        data={[
          sellerLd(seller, locale, rating, trust?.storefrontSlug ? { sameAs: [absoluteUrl(`/store/${trust.storefrontSlug}`)] } : {}),
          breadcrumbLd([{ name: ui.home, path: localizePath("/", locale) }, { name: tm("title"), path: localizePath("/manufacturers", locale) }, { name: seller.name }]),
        ]}
      />
      <Breadcrumbs linkComponent={Link} label={ui.breadcrumb} items={[{ label: ui.home, href: "/" }, { label: tm("title"), href: "/manufacturers" }, { label: seller.name }]} />
      <Card className="mt-5">
        <CardBody className="flex flex-col gap-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <Avatar name={seller.name} size="lg" className="size-20 text-2xl" />
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-bold tracking-tight text-ink">{seller.name}</h1>
              {place ? (
                <p className="mt-1 inline-flex items-center gap-1 text-sm text-muted">
                  <MapPin className="size-4" aria-hidden /> {place}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <TrustBadge tier={seller.verificationTier} badgeActive={seller.badgeActive} labels={ui.trust} />
                {trust ? (
                  <a href="#verification" className="inline-flex min-h-6 items-center text-sm font-medium text-brand-700 underline">
                    {tx("card.checksPassed", { passed: trust.passedChecks.length })}
                  </a>
                ) : null}
                <span className="text-sm text-muted">{t("trustScore", { score: seller.trustScore })}</span>
                {rating ? (
                  <a href="#reviews" className="inline-flex min-h-6 items-center">
                    <RatingStars average={rating.average} count={rating.count} />
                  </a>
                ) : null}
              </div>
              {trust ? (
                <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
                  {fact(tx("card.responseTime"), resp.time ?? tx("card.newSupplier"))}
                  {fact(tx("card.acceptRate"), resp.accept ?? tx("card.newSupplier"))}
                  {fact(tx("card.onPlatform"), yearsText(trust, tx))}
                  {fact(tx("card.products"), String(trust.liveListings))}
                </dl>
              ) : null}
              {trust ? <p className="mt-2 text-xs text-muted">{trust.response.isNew ? tx("card.newSupplierHint") : tx("values.window")}</p> : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label={tx("profile.actions")}>
            <Link href={`/rfq/new?seller=${id}`} className={buttonClasses("accent", "lg")}>
              {tsh("requestQuote")}
            </Link>
            {firstListing ? <UnlockButton trigger="pdp_contact_seller" unlock="seller_contact" listingId={firstListing.id} listingTitle={firstListing.title} label={tx("profile.contact")} variant="outline" size="lg" /> : null}
            <ShareButton label={tx("profile.share")} copiedLabel={tx("profile.shareCopied")} title={seller.name} />
            {trust?.storefrontSlug ? (
              <a href={`/store/${trust.storefrontSlug}`} className={buttonClasses("outline", "md")}>
                <Store className="size-4" aria-hidden /> {tx("profile.storefront")}
              </a>
            ) : null}
            <Link href={reportHref} className={buttonClasses("ghost", "md")}>
              <Flag className="size-4" aria-hidden /> {tx("profile.report")}
            </Link>
          </div>
        </CardBody>
      </Card>

      <div className="mt-8">
        <ProfileTabs
          label={tx("profile.tabsLabel")}
          tabs={[
            { id: "about", label: tx("profile.about"), panel: aboutPanel },
            { id: "products", label: `${tx("profile.products")} (${listings.length})`, panel: productsPanel },
            { id: "reviews", label: `${tx("profile.reviews")}${rating ? ` (${rating.count})` : ""}`, panel: reviewsPanel },
            { id: "verification", label: tx("profile.verification"), panel: verificationPanel },
          ]}
        />
      </div>
    </Container>
  );
}

/** Translated state label for a stored English state name (falls back to the stored value). */
async function stateLabelFor(locale: string, name: string | null | undefined): Promise<string> {
  const ts = await getTranslations({ locale, namespace: "states" });
  return stateLabel(name, (code) => (ts.has(code) ? ts(code) : undefined));
}
