import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MapPin } from "lucide-react";
import { Avatar, Breadcrumbs, buttonClasses, Card, CardBody, CompareToggle, Container, Grid, Money, SectionHeader, TrustBadge, WishlistButton } from "@cnote/ui";
import { toggleCompareAction } from "@/features/compare/actions";
import { readCompareIds } from "@/features/compare/state";
import { toggleSavedAction } from "@/features/wishlist/actions";
import { loadSavedState } from "@/features/wishlist/saved";
import { ListingCard } from "@/features/search/cards";
import { isPublic, loadCategory, loadHits, loadListing, loadSeller } from "@/features/search/data";
import { moqText } from "@/features/search/format";
import { ProductImage } from "@/features/search/product-image";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata(props: PageProps<"/products/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const l = UUID.test(id) ? await loadListing(id) : null;
  return l && isPublic(l) ? { title: l.title, description: l.description.slice(0, 160) } : { title: "Product" };
}

const prettify = (k: string) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export default async function ProductPage(props: PageProps<"/products/[id]">) {
  const { id } = await props.params;
  if (!UUID.test(id)) notFound();
  const listing = await loadListing(id);
  if (!listing || !isPublic(listing)) notFound();

  const [seller, category, similar, { signedIn, saved }, tray] = await Promise.all([
    loadSeller(listing.sellerBusinessId),
    loadCategory(listing.category.slug),
    loadHits({ q: listing.title, limit: 9 }),
    loadSavedState(),
    readCompareIds(),
  ]);
  const fields = new Map((category?.attributeSchema.fields ?? []).map((f) => [f.key, f]));
  const attrs = Object.entries(listing.attributes ?? {}).filter(([, v]) => v !== "" && v != null);
  const moq = moqText(listing);
  const others = similar.hits.filter((h) => h.listing.id !== listing.id).slice(0, 4);

  return (
    <Container className="py-6 lg:py-8">
      <Breadcrumbs
        linkComponent={Link}
        items={[{ label: "Home", href: "/" }, { label: listing.category.name, href: `/categories/${listing.category.slug}` }, { label: listing.title }]}
      />
      <div className="mt-5 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <div className="relative aspect-square overflow-hidden rounded-card border border-line bg-surface">
            <ProductImage src={listing.imageUrls[0]} sizes="(min-width: 1024px) 45vw, 100vw" priority />
          </div>
          {listing.imageUrls.length > 1 ? (
            <ul className="mt-3 grid grid-cols-4 gap-3">
              {listing.imageUrls.slice(1, 5).map((u) => (
                <li key={u} className="relative aspect-square overflow-hidden rounded-lg border border-line bg-surface">
                  <ProductImage src={u} sizes="12vw" />
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="flex flex-col gap-5">
          <div>
            <h1 className="text-2xl font-bold leading-tight tracking-tight text-ink sm:text-3xl">{listing.title}</h1>
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
            <WishlistButton
              id={listing.id}
              title={listing.title}
              saved={saved.has(listing.id)}
              onToggle={signedIn ? toggleSavedAction : undefined}
              className="size-12"
            />
            <CompareToggle id={listing.id} title={listing.title} inTray={tray.includes(listing.id)} onToggle={toggleCompareAction} variant="button" />
          </div>

          {seller ? (
            <Card>
              <CardBody className="flex items-start gap-3">
                <Avatar name={seller.name} size="lg" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">Supplier</p>
                  <h2 className="truncate text-base font-semibold text-ink">
                    <Link href={`/manufacturers/${seller.businessId}`} className="hover:text-brand-700 hover:underline">
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
            <dl className="mt-2 divide-y divide-line overflow-hidden rounded-card border border-line bg-surface text-sm">
              {attrs.map(([k, v]) => {
                const f = fields.get(k);
                return (
                  <div key={k} className="grid grid-cols-[9rem_1fr] gap-3 px-4 py-2.5">
                    <dt className="text-muted">{f?.label ?? prettify(k)}</dt>
                    <dd className="font-medium text-ink">
                      {String(v)}
                      {f?.unit ? ` ${f.unit}` : ""}
                    </dd>
                  </div>
                );
              })}
              {listing.hsn ? (
                <div className="grid grid-cols-[9rem_1fr] gap-3 px-4 py-2.5">
                  <dt className="text-muted">HSN code</dt>
                  <dd className="font-medium text-ink">{listing.hsn}</dd>
                </div>
              ) : null}
              <div className="grid grid-cols-[9rem_1fr] gap-3 px-4 py-2.5">
                <dt className="text-muted">Category</dt>
                <dd className="font-medium text-ink">{listing.category.name}</dd>
              </div>
            </dl>
          </section>
        </div>
      </div>

      {others.length ? (
        <section className="mt-12" aria-labelledby="similar">
          <SectionHeader id="similar" title="Similar products" />
          <Grid>
            {others.map((h) => (
              <ListingCard key={h.listing.id} listing={h.listing} seller={h.seller} />
            ))}
          </Grid>
        </section>
      ) : null}
    </Container>
  );
}
