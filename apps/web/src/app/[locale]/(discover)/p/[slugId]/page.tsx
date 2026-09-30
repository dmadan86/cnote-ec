import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound, permanentRedirect } from "next/navigation";
import { MapPin } from "lucide-react";
import { Avatar, Breadcrumbs, Card, CardBody, Container, Grid, Money, SectionHeader, TrustBadge } from "@cnote/ui";
import { LOCALE_META, localizePath } from "@/i18n/config";
import { LocaleLink as Link } from "@/i18n/link";
import { resolveLocale } from "@/i18n/server";
import { JsonLd } from "@/lib/json-ld";
import { categoryPath, parseProductParam, productPath, sellerPath } from "@/lib/paths";
import { breadcrumbLd, productLd } from "@/lib/schema";
import { localizedAlternates } from "@/lib/seo-i18n";
import { ListingCard } from "@/features/search/cards";
import { isPublic, loadCategory, loadHitsStatic, loadListing, loadListingIndex, loadRatingSummary, loadRatings, loadReviewsPage, loadSeller } from "@/features/search/data";
import { getUiLabels } from "@/features/search/labels";
import { moqText } from "@/features/search/format";
import { ProductImage } from "@/features/search/product-image";
import { ProductReviewsStatic } from "@/features/reviews";
import { RatingStars } from "@/features/reviews/stars";
import { LeadNudge } from "@/features/leadgen/nudge";
import { loadOffer } from "@/features/promotions/data";
import { OfferPanel } from "@/features/promotions/offer-panel";
import { UnlockButton } from "@/features/leadgen/unlock-buttons";
import { CompareIsland, SaveIsland } from "@/features/user-state/islands";
import { SponsoredSimilar } from "@/features/ads/similar";
import { stateLabel } from "@/features/identity/states";

// Product pages are static: the top 100 listings are prerendered at build time, everything else renders on first
// request and is then cached (ISR). Regenerated at most every 5 min, and immediately (stale-while-revalidate, or
// blocking for moderation) when `listing:<id>`, `seller:<id>`, `rating:<id>` / `reviews:<id>` tags are purged.
// Nothing here reads cookies: heart / compare / review forms are client islands.
export const revalidate = 300;

export async function generateStaticParams() {
  return (await loadListingIndex(0, 100)).map((l) => ({ slugId: `${productPath(l).slice("/p/".length)}` }));
}

const prettify = (k: string) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

async function load(slugId: string) {
  const parsed = parseProductParam(slugId);
  if (!parsed) return null;
  const listing = await loadListing(parsed.id);
  return listing && isPublic(listing) ? { parsed, listing } : null;
}

export async function generateMetadata(props: PageProps<"/[locale]/p/[slugId]">): Promise<Metadata> {
  const locale = await resolveLocale(props.params);
  const { slugId } = await props.params;
  const t = await getTranslations({ locale, namespace: "product" });
  const r = await load(slugId);
  if (!r) return { title: t("notFound"), robots: { index: false, follow: false } };
  const { listing: l } = r;
  const seller = await loadSeller(l.sellerBusinessId);
  const price = l.pricePaise != null ? t("priceFrom", { price: `₹${(l.pricePaise / 100).toLocaleString(LOCALE_META[locale].bcp47)}` }) : "";
  const title = seller ? t("by", { title: l.title, seller: seller.name }) : l.title;
  // Listing text is seller-authored catalogue data (one language); the generated fallback sentence is translated.
  const description = (l.description || t("fallbackDescription", { title: l.title, price })).replace(/\s+/g, " ").trim().slice(0, 158);
  const alternates = localizedAlternates(productPath(l), locale);
  return {
    title,
    description,
    alternates,
    // og:image comes from ./opengraph-image.tsx (dynamic per product).
    openGraph: { type: "website", title, description, url: alternates.canonical },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function ProductPage(props: PageProps<"/[locale]/p/[slugId]">) {
  const locale = await resolveLocale(props.params);
  const { slugId } = await props.params;
  const t = await getTranslations({ locale, namespace: "product" });
  const ui = await getUiLabels(locale);
  const r = await load(slugId);
  if (!r) notFound();
  const { parsed, listing } = r;
  // Self-healing canonical URL: wrong / missing / stale slug (title edited) -> 308 to /p/<current-slug>-<id>.
  if (parsed.slug !== productPath(listing).slice("/p/".length, -37)) permanentRedirect(localizePath(productPath(listing), locale));

  const [seller, category, similar, summary, reviews, offer] = await Promise.all([
    loadSeller(listing.sellerBusinessId),
    loadCategory(listing.category.slug),
    loadHitsStatic({ q: listing.title, limit: 9 }, [`listing:${listing.id}`]),
    loadRatingSummary(listing.id),
    loadReviewsPage(listing.id),
    loadOffer(listing.id),
  ]);
  const others = similar.hits.filter((h) => h.listing.id !== listing.id).slice(0, 4);
  const sellerState = seller ? await stateLabelFor(locale, seller.state) : "";
  const ratings = await loadRatings(others.map((h) => h.listing.id));
  const otherOffers = await Promise.all(others.map((h) => loadOffer(h.listing.id)));
  const fields = new Map((category?.attributeSchema.fields ?? []).map((f) => [f.key, f]));
  const attrs = Object.entries(listing.attributes ?? {}).filter(([, v]) => v !== "" && v != null);
  const moq = moqText(listing);
  const rating = summary && summary.count > 0 ? { average: summary.average, count: summary.count } : null;

  const facts: [string, string][] = [
    ...attrs.map(([k, v]): [string, string] => {
      const f = fields.get(k);
      return [f?.label ?? prettify(k), `${String(v)}${f?.unit ? ` ${f.unit}` : ""}`];
    }),
    ...(listing.hsn ? ([[t("hsn"), listing.hsn]] as [string, string][]) : []),
    [t("category"), listing.category.name],
    ...(moq ? ([[t("minimumOrder"), moq]] as [string, string][]) : []),
  ];

  return (
    <Container className="py-6 lg:py-8">
      <JsonLd
        data={[
          productLd(listing, seller, rating, reviews.items.slice(0, 5).map((v) => ({ rating: v.rating, author: v.authorName, body: v.body.slice(0, 500), date: v.createdAt.slice(0, 10) })), locale),
          breadcrumbLd([{ name: ui.home, path: localizePath("/", locale) }, { name: listing.category.name, path: localizePath(categoryPath(listing.category.slug), locale) }, { name: listing.title }]),
        ]}
      />
      <Breadcrumbs linkComponent={Link} label={ui.breadcrumb} items={[{ label: ui.home, href: "/" }, { label: listing.category.name, href: categoryPath(listing.category.slug) }, { label: listing.title }]} />
      <div className="mt-5 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <div className="relative aspect-square overflow-hidden rounded-card border border-line bg-surface">
            <ProductImage src={listing.imageUrls[0]} sizes="(min-width: 1024px) 45vw, 100vw" priority preload alt={listing.title} />
          </div>
          {listing.imageUrls.length > 1 ? (
            <ul className="mt-3 grid grid-cols-4 gap-3">
              {listing.imageUrls.slice(1, 5).map((u, i) => (
                <li key={u} className="relative aspect-square overflow-hidden rounded-lg border border-line bg-surface">
                  <ProductImage src={u} sizes="12vw" alt={t("imageAlt", { title: listing.title, n: i + 2 })} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="flex flex-col gap-5">
          <div>
            <h1 className="text-2xl font-bold leading-tight tracking-tight text-ink sm:text-3xl">{listing.title}</h1>
            {rating ? (
              <p className="mt-2">
                <a href="#reviews" className="inline-flex min-h-6 items-center hover:underline">
                  <RatingStars average={rating.average} count={rating.count} />
                </a>
              </p>
            ) : null}
            <div className="mt-3">
              {listing.pricePaise != null ? <Money paise={listing.pricePaise} unit={listing.priceUnit} className="text-3xl" /> : <span className="text-lg font-semibold text-muted">{t("priceOnRequest")}</span>}
            </div>
            {moq ? <p className="mt-1 text-sm text-muted">{t("minOrder", { value: moq })}</p> : null}
            <p className="mt-1 text-xs text-muted">{t("indicative")}</p>
          </div>

          {offer ? <OfferPanel offer={offer} unit={listing.priceUnit} locale={locale} /> : null}

          <div className="flex flex-wrap items-center gap-3">
            {/* Client islands: the dialog opens only on click (never on load), signed-in buyers skip it. */}
            <UnlockButton trigger="pdp_best_price" unlock="enquiry" listingId={listing.id} listingTitle={listing.title} label={t("getBestPrice")} className="w-full sm:w-auto" />
            <UnlockButton trigger="request_quote" unlock="quotes" listingId={listing.id} listingTitle={listing.title} label={t("requestQuote")} variant="outline-brand" className="w-full sm:w-auto" />
            <SaveIsland id={listing.id} title={listing.title} className="size-12" />
            <CompareIsland id={listing.id} title={listing.title} variant="button" />
          </div>

          <LeadNudge listingId={listing.id} listingTitle={listing.title} />

          {seller ? (
            <Card>
              <CardBody className="flex items-start gap-3">
                <Avatar name={seller.name} size="lg" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">{t("supplier")}</p>
                  <h2 className="truncate text-base font-semibold text-ink">
                    <Link href={sellerPath(seller.businessId)} className="hover:text-brand-700 hover:underline">
                      {seller.name}
                    </Link>
                  </h2>
                  <p className="mt-0.5 inline-flex items-center gap-1 text-sm text-muted">
                    <MapPin className="size-3.5" aria-hidden /> {[seller.city, sellerState].filter(Boolean).join(", ") || t("india")}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <TrustBadge tier={seller.verificationTier} badgeActive={seller.badgeActive} labels={ui.trust} />
                    <span className="text-xs text-muted">{t("trustScore", { score: seller.trustScore })}</span>
                  </div>
                  <div className="mt-3">
                    <UnlockButton trigger="pdp_contact_seller" unlock="seller_contact" listingId={listing.id} listingTitle={listing.title} label={t("contactSeller")} variant="outline" size="md" />
                  </div>
                </div>
              </CardBody>
            </Card>
          ) : null}

          {listing.description ? (
            <section aria-labelledby="desc">
              <h2 id="desc" className="text-base font-bold text-ink">
                {t("description")}
              </h2>
              <p className="mt-1.5 whitespace-pre-line text-sm leading-6 text-ink/80">{listing.description}</p>
            </section>
          ) : null}

          <section aria-labelledby="specs">
            <h2 id="specs" className="text-base font-bold text-ink">
              {t("specifications")}
            </h2>
            {/* A real table: crawlers and LLMs extract facts from tables reliably, and screen readers announce row/column headers. */}
            <div className="mt-2 overflow-hidden rounded-card border border-line bg-surface">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">{t("specsCaption", { title: listing.title })}</caption>
                <tbody className="divide-y divide-line">
                  {facts.map(([k, v]) => (
                    <tr key={k}>
                      <th scope="row" className="w-40 px-4 py-2.5 text-left font-normal text-muted">
                        {k}
                      </th>
                      <td className="px-4 py-2.5 font-medium text-ink">{v}</td>
                    </tr>
                  ))}
                  {listing.pricePaise != null ? (
                    <tr>
                      <th scope="row" className="w-40 px-4 py-2.5 text-left font-normal text-muted">
                        {t("indicativePrice")}
                      </th>
                      <td className="px-4 py-2.5 font-medium text-ink">
                        <Money paise={listing.pricePaise} unit={listing.priceUnit} />
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>

      <div className="mt-12">
        <ProductReviewsStatic listingId={listing.id} />
      </div>

      {others.length ? (
        <section className="mt-12" aria-labelledby="similar">
          <SectionHeader id="similar" title={t("similar")} />
          <Grid>
            {others.map((h, i) => (
              <ListingCard key={h.listing.id} listing={h.listing} seller={h.seller} rating={ratings[h.listing.id]} locale={locale} offer={otherOffers[i]} />
            ))}
          </Grid>
        </section>
      ) : null}

      <SponsoredSimilar listingId={listing.id} locale={locale} />
    </Container>
  );
}

/** Translated state label for a stored English state name (falls back to the stored value). */
async function stateLabelFor(locale: string, name: string | null | undefined): Promise<string> {
  const ts = await getTranslations({ locale, namespace: "states" });
  return stateLabel(name, (code) => (ts.has(code) ? ts(code) : undefined));
}
