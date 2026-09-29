import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MapPin } from "lucide-react";
import { Avatar, Breadcrumbs, buttonClasses, Card, CardBody, Container, EmptyState, Grid, SectionHeader, TrustBadge } from "@cnote/ui";
import { JsonLd } from "@/lib/json-ld";
import { isUuid, sellerPath } from "@/lib/paths";
import { breadcrumbLd, sellerLd } from "@/lib/schema";
import { ListingCard } from "@/features/search/cards";
import { loadRatings, loadSeller, loadSellerIndex, loadSellerListings } from "@/features/search/data";

// Static + ISR like product pages: top sellers prerendered, the rest on first request; purged by seller:<id> / seller-listings:<id>.
export const revalidate = 300;

const TIER = ["Phone verified", "GST verified", "KYC verified", "Audited"];

export async function generateStaticParams() {
  return (await loadSellerIndex(0, 50)).map((s) => ({ id: s.businessId }));
}

export async function generateMetadata(props: PageProps<"/manufacturers/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const s = isUuid(id) ? await loadSeller(id) : null;
  if (!s) return { title: "Supplier not found", robots: { index: false, follow: false } };
  const place = [s.city, s.state].filter(Boolean).join(", ");
  const title = `${s.name}${place ? `, ${place}` : ""}`;
  const description = `${s.name}${place ? ` in ${place}` : ""}: ${TIER[Math.min(s.verificationTier, 3)].toLowerCase()} supplier with a trust score of ${s.trustScore}/100. See products and request a quote.`;
  return { title, description, alternates: { canonical: sellerPath(id) }, openGraph: { title, description, type: "profile", url: sellerPath(id) }, twitter: { card: "summary", title, description } };
}

export default async function ManufacturerPage(props: PageProps<"/manufacturers/[id]">) {
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const seller = await loadSeller(id);
  if (!seller) notFound();
  const listings = await loadSellerListings(id);
  const ratings = await loadRatings(listings.map((l) => l.id));
  const place = [seller.city, seller.state].filter(Boolean).join(", ");

  return (
    <Container className="py-6 lg:py-8">
      <JsonLd data={[sellerLd(seller), breadcrumbLd([{ name: "Home", path: "/" }, { name: "Manufacturers", path: "/manufacturers" }, { name: seller.name }])]} />
      <Breadcrumbs linkComponent={Link} items={[{ label: "Home", href: "/" }, { label: "Manufacturers", href: "/manufacturers" }, { label: seller.name }]} />
      <Card className="mt-5">
        <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <Avatar name={seller.name} size="lg" className="size-20 text-2xl" />
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold tracking-tight text-ink">{seller.name}</h1>
            {place ? (
              <p className="mt-1 inline-flex items-center gap-1 text-sm text-muted">
                <MapPin className="size-4" aria-hidden /> {place}
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <TrustBadge tier={seller.verificationTier} badgeActive={seller.badgeActive} />
              <span className="text-sm text-muted">Trust score {seller.trustScore}/100</span>
              <span className="text-sm text-muted">Verification level: {TIER[Math.min(seller.verificationTier, 3)]}</span>
              {seller.languages.length ? <span className="text-sm text-muted">Languages: {seller.languages.join(", ")}</span> : null}
            </div>
          </div>
          <Link href="/rfq/new" className={buttonClasses("accent", "lg")}>
            Request Quote
          </Link>
        </CardBody>
      </Card>

      <section className="mt-10" aria-labelledby="listings">
        <SectionHeader id="listings" title={`Products from ${seller.name}`} />
        {listings.length ? (
          <Grid>
            {listings.map((l) => (
              <ListingCard key={l.id} listing={l} rating={ratings[l.id]} />
            ))}
          </Grid>
        ) : (
          <EmptyState title="No published products yet" description="This supplier has not published any listings. You can still request a quote." action={<Link href="/rfq/new" className={buttonClasses("accent")}>Request Quote</Link>} />
        )}
      </section>
    </Container>
  );
}
