import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { MapPin } from "lucide-react";
import { Avatar, Breadcrumbs, buttonClasses, Card, CardBody, Container, Grid, Money, SectionHeader, TrustBadge } from "@cnote/ui";
import { JsonLd } from "@/lib/json-ld";
import { categoryPath, parseProductParam, productPath, sellerPath } from "@/lib/paths";
import { breadcrumbLd, productLd } from "@/lib/schema";
import { ListingCard } from "@/features/search/cards";
import { isPublic, loadCategory, loadHitsStatic, loadListing, loadListingIndex, loadRatingSummary, loadRatings, loadReviewsPage, loadSeller } from "@/features/search/data";
import { moqText } from "@/features/search/format";
import { ProductImage } from "@/features/search/product-image";
import { ProductReviewsStatic } from "@/features/reviews";
import { RatingStars } from "@/features/reviews/stars";
import { CompareIsland, SaveIsland } from "@/features/user-state/islands";

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

export async function generateMetadata(props: PageProps<"/p/[slugId]">): Promise<Metadata> {
  const { slugId } = await props.params;
  const r = await load(slugId);
  if (!r) return { title: "Product not found", robots: { index: false, follow: false } };
  const { listing: l } = r;
  const seller = await loadSeller(l.sellerBusinessId);
  const price = l.pricePaise != null ? ` from ₹${(l.pricePaise / 100).toLocaleString("en-IN")}` : "";
  const title = `${l.title}${seller ? ` by ${seller.name}` : ""}`;
  const description = (l.description || `${l.title}${price}. Verified supplier on the marketplace.`).replace(/\s+/g, " ").trim().slice(0, 158);
  const path = productPath(l);
  return {
    title,
    description,
    alternates: { canonical: path, languages: { "en-IN": path } },
    // og:image comes from ./opengraph-image.tsx (dynamic per product).
    openGraph: { type: "website", title, description, url: path },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function ProductPage(props: PageProps<"/p/[slugId]">) {
  const { slugId } = await props.params;
  const r = await load(slugId);
  if (!r) notFound();
  const { parsed, listing } = r;
  // Self-healing canonical URL: wrong / missing / stale slug (title edited) -> 308 to /p/<current-slug>-<id>.
  if (parsed.slug !== productPath(listing).slice("/p/".length, -37)) permanentRedirect(productPath(listing));

  const [seller, category, similar, summary, reviews] = await Promise.all([
    loadSeller(listing.sellerBusinessId),
    loadCategory(listing.category.slug),
    loadHitsStatic({ q: listing.title, limit: 9 }, [`listing:${listing.id}`]),
    loadRatingSummary(listing.id),
    loadReviewsPage(listing.id),
  ]);
  const others = similar.hits.filter((h) => h.listing.id !== listing.id).slice(0, 4);
  const ratings = await loadRatings(others.map((h) => h.listing.id));
  const fields = new Map((category?.attributeSchema.fields ?? []).map((f) => [f.key, f]));
  const attrs = Object.entries(listing.attributes ?? {}).filter(([, v]) => v !== "" && v != null);
  const moq = moqText(listing);
  const rating = summary && summary.count > 0 ? { average: summary.average, count: summary.count } : null;

  const facts: [string, string][] = [
    ...attrs.map(([k, v]): [string, string] => {
      const f = fields.get(k);
      return [f?.label ?? prettify(k), `${String(v)}${f?.unit ? ` ${f.unit}` : ""}`];
    }),
    ...(listing.hsn ? ([["HSN code", listing.hsn]] as [string, string][]) : []),
    ["Category", listing.category.name],
    ...(moq ? ([["Minimum order", moq]] as [string, string][]) : []),
  ];

  return (
    <Container className="py-6 lg:py-8">
      <JsonLd
        data={[
          productLd(listing, seller, rating, reviews.items.slice(0, 5).map((v) => ({ rating: v.rating, author: v.authorName, body: v.body.slice(0, 500), date: v.createdAt.slice(0, 10) }))),
          breadcrumbLd([{ name: "Home", path: "/" }, { name: listing.category.name, path: categoryPath(listing.category.slug) }, { name: listing.title }]),
        ]}
      />
      <Breadcrumbs linkComponent={Link} items={[{ label: "Home", href: "/" }, { label: listing.category.name, href: categoryPath(listing.category.slug) }, { label: listing.title }]} />
      <div className="mt-5 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <div className="relative aspect-square overflow-hidden rounded-card border border-line bg-surface">
            <ProductImage src={listing.imageUrls[0]} sizes="(min-width: 1024px) 45vw, 100vw" priority preload alt={listing.title} />
          </div>
          {listing.imageUrls.length > 1 ? (
            <ul className="mt-3 grid grid-cols-4 gap-3">
              {listing.imageUrls.slice(1, 5).map((u, i) => (
                <li key={u} className="relative aspect-square overflow-hidden rounded-lg border border-line bg-surface">
                  <ProductImage src={u} sizes="12vw" alt={`${listing.title}, image ${i + 2}`} />
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
              {listing.pricePaise != null ? <Money paise={listing.pricePaise} unit={listing.priceUnit} className="text-3xl" /> : <span className="text-lg font-semibold text-muted">Price on request</span>}
            </div>
            {moq ? <p className="mt-1 text-sm text-muted">Min. order: {moq}</p> : null}
            <p className="mt-1 text-xs text-muted">Indicative price. The supplier confirms the final quote for your quantity and delivery location.</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Link href={`/rfq/new?listing=${listing.id}`} className={buttonClasses("accent", "lg", "w-full sm:w-auto")}>
              Request Quote
            </Link>
            <SaveIsland id={listing.id} title={listing.title} className="size-12" />
            <CompareIsland id={listing.id} title={listing.title} variant="button" />
          </div>

          {seller ? (
            <Card>
              <CardBody className="flex items-start gap-3">
                <Avatar name={seller.name} size="lg" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">Supplier</p>
                  <h2 className="truncate text-base font-semibold text-ink">
                    <Link href={sellerPath(seller.businessId)} className="hover:text-brand-700 hover:underline">
                      {seller.name}
                    </Link>
                  </h2>
                  <p className="mt-0.5 inline-flex items-center gap-1 text-sm text-muted">
                    <MapPin className="size-3.5" aria-hidden /> {[seller.city, seller.state].filter(Boolean).join(", ") || "India"}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <TrustBadge tier={seller.verificationTier} badgeActive={seller.badgeActive} />
                    <span className="text-xs text-muted">Trust score {seller.trustScore}/100</span>
                  </div>
                </div>
              </CardBody>
            </Card>
          ) : null}

          {listing.description ? (
            <section aria-labelledby="desc">
              <h2 id="desc" className="text-base font-bold text-ink">
                Description
              </h2>
              <p className="mt-1.5 whitespace-pre-line text-sm leading-6 text-ink/80">{listing.description}</p>
            </section>
          ) : null}

          <section aria-labelledby="specs">
            <h2 id="specs" className="text-base font-bold text-ink">
              Specifications
            </h2>
            {/* A real table: crawlers and LLMs extract facts from tables reliably, and screen readers announce row/column headers. */}
            <div className="mt-2 overflow-hidden rounded-card border border-line bg-surface">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">Specifications of {listing.title}</caption>
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
                        Indicative price
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
          <SectionHeader id="similar" title="Similar products" />
          <Grid>
            {others.map((h) => (
              <ListingCard key={h.listing.id} listing={h.listing} seller={h.seller} rating={ratings[h.listing.id]} />
            ))}
          </Grid>
        </section>
      ) : null}
    </Container>
  );
}
