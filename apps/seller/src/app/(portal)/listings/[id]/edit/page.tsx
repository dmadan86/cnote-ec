import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { Alert, PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { catalogue } from "@/lib/services";
import { ImageManager } from "@/features/images/image-manager";
import { ListingEditor } from "@/features/listings/listing-editor";
import { ListingStatusBadges } from "@/features/listings/status-badges";
import { VariantsEditor } from "@/features/listings/variants-editor";
import { categoryAxes, type SellerVariantView } from "@cnote/catalogue";
import { VersionPanel, type PanelOverview } from "@/features/listings/version-panel";

const WEB_ORIGIN = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("listings.meta"))("edit") };
}

export default async function EditListingPage({ params }: PageProps<"/listings/[id]/edit">) {
  const t = await getTranslations("listings.edit");
  const tv = await getTranslations("stock.variants");
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
      <PageHeader title={t("title")} description={t("description")} />
      <ListingStatusBadges listing={listing.data} />
      <ImageManager listingId={listing.data.id} initialImages={images.ok ? images.data : []} />
      <ListingEditor listing={listing.data} categories={cats.data.filter((c) => !c.prohibited)} mode="portal" defaultLanguage={session.preferredLanguage} />
      <VariantsEditor
        key={listing.data.updatedAt}
        listingId={listing.data.id}
        axes={categoryAxes(cats.data.find((c) => c.id === listing.data!.category.id)?.attributeSchema)}
        initial={(listing.data.variants ?? []) as SellerVariantView[]}
        images={(images.ok ? images.data : []).filter((im) => im.status === "approved").map((im, i) => ({ id: im.id, label: tv("imageOption", { n: i + 1 }) }))}
        skuBase={listing.data.sku ?? listing.data.title}
      />
      {overview.ok ? <VersionPanel overview={overview.data} /> : <Alert tone="danger">{overview.error}</Alert>}
    </div>
  );
}
