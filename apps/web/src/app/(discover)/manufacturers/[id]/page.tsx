import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MapPin } from "lucide-react";
import { Avatar, Breadcrumbs, buttonClasses, Card, CardBody, Container, EmptyState, Grid, SectionHeader, TrustBadge } from "@cnote/ui";
import { ListingCard } from "@/features/search/cards";
import { loadSeller, loadSellerListings } from "@/features/search/data";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIER = ["Phone verified", "GST verified", "KYC verified", "Audited"];

export async function generateMetadata(props: PageProps<"/manufacturers/[id]">): Promise<Metadata> {
  const { id } = await props.params;
  const s = UUID.test(id) ? await loadSeller(id) : null;
  return { title: s?.name ?? "Supplier" };
}

export default async function ManufacturerPage(props: PageProps<"/manufacturers/[id]">) {
  const { id } = await props.params;
  if (!UUID.test(id)) notFound();
  const seller = await loadSeller(id);
  if (!seller) notFound();
  const listings = await loadSellerListings(id);
  const place = [seller.city, seller.state].filter(Boolean).join(", ");

  return (
    <Container className="py-6 lg:py-8">
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
              <ListingCard key={l.id} listing={l} />
            ))}
          </Grid>
        ) : (
          <EmptyState title="No published products yet" description="This supplier has not published any listings. You can still request a quote." action={<Link href="/rfq/new" className={buttonClasses("accent")}>Request Quote</Link>} />
        )}
      </section>
    </Container>
  );
}
