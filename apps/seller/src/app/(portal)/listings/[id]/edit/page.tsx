import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert, PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { catalogue } from "@/lib/services";
import { ImageManager } from "@/features/images/image-manager";
import { ListingEditor } from "@/features/listings/listing-editor";
import { ListingStatusBadges } from "@/features/listings/status-badges";
import { VersionPanel, type PanelOverview } from "@/features/listings/version-panel";

const WEB_ORIGIN = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");

export const metadata: Metadata = { title: "Edit listing" };

export default async function EditListingPage({ params }: PageProps<"/listings/[id]/edit">) {
  const { id } = await params;
  const session = await requireSeller(`/listings/${id}/edit`);
  const [listing, cats] = await Promise.all([load(() => catalogue.getListing(id)), load(() => catalogue.listCategories())]);
  const overview = await load(async (): Promise<PanelOverview> => {
    const o = await catalogue.getVersionOverview(session.business.id, id);
    return { ...o, versions: o.versions.map((v) => ({ ...v, previewUrl: `${WEB_ORIGIN}/preview/listing/${v.id}?token=${encodeURIComponent(catalogue.createPreviewToken(v.id))}` })) };
  });
  const images = await load(() => catalogue.listSellerListingImages(session.business.id, id).catch(() => []));
  if (!listing.ok || !cats.ok) return <Alert tone="danger">{listing.ok ? (cats.ok ? "" : cats.error) : listing.error}</Alert>;
  if (!listing.data || listing.data.sellerBusinessId !== session.business.id) notFound();
  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Edit listing" description="Edits are saved to your working copy. Buyers see a new version only after you submit it and it is approved." />
      <ListingStatusBadges listing={listing.data} />
      <ImageManager listingId={listing.data.id} initialImages={images.ok ? images.data : []} />
      <ListingEditor listing={listing.data} categories={cats.data.filter((c) => !c.prohibited)} mode="portal" defaultLanguage={session.preferredLanguage} />
      {overview.ok ? <VersionPanel overview={overview.data} /> : <Alert tone="danger">{overview.error}</Alert>}
    </div>
  );
}
