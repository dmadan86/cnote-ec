import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound, permanentRedirect } from "next/navigation";
import { Flag } from "lucide-react";
import { Breadcrumbs, Container, Grid, Money, SectionHeader } from "@cnote/ui";
import { absoluteUrl } from "@/lib/site-url";
import { LOCALE_META, localizePath } from "@/i18n/config";
import { LocaleLink as Link } from "@/i18n/link";
import { resolveLocale } from "@/i18n/server";
import { JsonLd } from "@/lib/json-ld";
import { categoryPath, parseProductParam, productPath } from "@/lib/paths";
import { breadcrumbLd, faqLd, productLd } from "@/lib/schema";
import { localizedAlternates } from "@/lib/seo-i18n";
import { ListingCard } from "@/features/search/cards";
import { isPublic, loadCategory, loadHitsStatic, loadListing, loadListingIndex, loadQaPage, loadRatingSummary, loadRatings, loadReviewsPage, loadSeller } from "@/features/search/data";
import { getUiLabels } from "@/features/search/labels";
import { moqText } from "@/features/search/format";
import { Gallery } from "@/features/pdp/gallery";
import { PurchasePanel } from "@/features/pdp/purchase-panel";
import { ShareMenu } from "@/features/pdp/share-menu";
import { TradeInfo } from "@/features/pdp/trade-info";
import { ProductQa } from "@/features/qa/section";
import { ProductReviewsStatic } from "@/features/reviews";
import { RatingStars } from "@/features/reviews/stars";
import { LeadNudge } from "@/features/leadgen/nudge";
import { loadOffer } from "@/features/promotions/data";
import { OfferPanel } from "@/features/promotions/offer-panel";
import { UnlockButton } from "@/features/leadgen/unlock-buttons";
import { CompareIsland, SaveIsland } from "@/features/user-state/islands";
import { SponsoredSimilar } from "@/features/ads/similar";
import { stateLabel } from "@/features/identity/states";
import { loadSupplierTrust } from "@/features/supplier/data";
import { SellerCard } from "@/features/supplier/seller-card";
import { SupplierContact } from "@/features/contact/supplier-contact";
import { RecentlyViewedRail, RecentlyViewedTracker } from "@/features/recently-viewed/rail";

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

  const [seller, category, similar, summary, reviews, offer, supplierTrust, qa] = await Promise.all([
    loadSeller(listing.sellerBusinessId),
    loadCategory(listing.category.slug),
    loadHitsStatic({ q: listing.title, limit: 9 }, [`listing:${listing.id}`]),
    loadRatingSummary(listing.id),
    loadReviewsPage(listing.id),
    loadOffer(listing.id),
    loadSupplierTrust(listing.sellerBusinessId),
    loadQaPage(listing.id),
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
    [t("category"), listing.category.name],
  ];
  const canonical = absoluteUrl(localizePath(productPath(listing), locale));
  const pdp = await getTranslations({ locale, namespace: "pdp" });
  const images = listing.imageUrls.slice(0, 10).map((src, i) => ({ src, blur: listing.imageBlurs?.[i] ?? null, alt: i === 0 ? listing.title : t("imageAlt", { title: listing.title, n: i + 1 }) }));

  return (
    <Container className="py-6 lg:py-8">
      <JsonLd
        data={[
          productLd(listing, seller, rating, reviews.items.slice(0, 5).map((v) => ({ rating: v.rating, author: v.authorName, body: v.body.slice(0, 500), date: v.createdAt.slice(0, 10) })), locale),
          ...[faqLd(qa.items.slice(0, 10).map((q) => ({ question: q.body, answer: q.answer.body, date: q.askedAt.slice(0, 10) })))].filter((x): x is NonNullable<typeof x> => x !== null),
          breadcrumbLd([{ name: ui.home, path: localizePath("/", locale) }, { name: listing.category.name, path: localizePath(categoryPath(listing.category.slug), locale) }, { name: listing.title }]),
        ]}
      />
      <Breadcrumbs linkComponent={Link} label={ui.breadcrumb} items={[{ label: ui.home, href: "/" }, { label: listing.category.name, href: categoryPath(listing.category.slug) }, { label: listing.title }]} />
      <div className="mt-5 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <Gallery images={images} title={listing.title} />
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
          </div>

          <PurchasePanel
            listingId={listing.id}
            listingTitle={listing.title}
            unit={listing.priceUnit}
            basePaise={listing.pricePaise}
            tiers={listing.priceTiers ?? []}
            moq={listing.moq}
            moqText={moq}
            moqUnit={listing.moqUnit}
            labels={{ priceOnRequest: t("priceOnRequest"), minOrder: moq ? t("minOrder", { value: moq }) : null, indicative: t("indicative"), getBestPrice: t("getBestPrice"), requestQuote: t("requestQuote") }}
            offer={offer ? <OfferPanel offer={offer} unit={listing.priceUnit} locale={locale} /> : null}
            actions={
              <>
                <SaveIsland id={listing.id} title={listing.title} className="size-12" />
                <CompareIsland id={listing.id} title={listing.title} variant="button" />
              </>
            }
          />

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <ShareMenu url={canonical} title={listing.title} />
            <Link href={`/report?url=${encodeURIComponent(canonical)}`} className="inline-flex min-h-11 items-center gap-1.5 text-sm text-muted underline-offset-2 hover:text-ink hover:underline">
              <Flag className="size-4" aria-hidden />
              {pdp("report")}
            </Link>
          </div>

          <LeadNudge listingId={listing.id} listingTitle={listing.title} />

          {seller ? (
            <SellerCard
              seller={seller}
              trust={supplierTrust}
              locale={locale}
              place={[seller.city, sellerState].filter(Boolean).join(", ")}
              contact={
                <SupplierContact listingId={listing.id} listingTitle={listing.title}>
                  <UnlockButton trigger="pdp_contact_seller" unlock="seller_contact" listingId={listing.id} listingTitle={listing.title} label={t("contactSeller")} variant="outline" size="md" />
                </SupplierContact>
              }
            />
          ) : null}

          <TradeInfo listing={listing} locale={locale} />

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

      <div className="mt-12">
        <ProductQa listingId={listing.id} locale={locale} />
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
      <RecentlyViewedTracker id={listing.id} />
      <RecentlyViewedRail excludeId={listing.id} className="mt-12" />
    </Container>
  );
}

/** Translated state label for a stored English state name (falls back to the stored value). */
async function stateLabelFor(locale: string, name: string | null | undefined): Promise<string> {
  const ts = await getTranslations({ locale, namespace: "states" });
  return stateLabel(name, (code) => (ts.has(code) ? ts(code) : undefined));
}
