import type { Prisma } from "@cnote/db";
import type { LiveListing } from "@cnote/live-db";
import type { CategoryView, ListingView } from "./index";
import { parsePriceTiers, parseTrade, tradeOfRow } from "./tiers";
import { effectiveAvailability, isAvailability, type Availability } from "./availability";
import { categoryAxes, parseAxes, parseVariants, type SellerVariantView } from "./variants";

export const listingInclude = {
  category: { select: { id: true, slug: true, name: true, attributeSchema: true } },
  variants: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
  // Buyers only ever see approved, non-deleted images (staff approval is mandatory).
  images: { where: { status: "approved", deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true } },
} satisfies Prisma.ListingInclude;
export type ListingRow = Prisma.ListingGetPayload<{ include: typeof listingInclude }>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

export function toCategoryView(c: Prisma.CategoryGetPayload<object>): CategoryView {
  const schema = c.attributeSchema as CategoryView["attributeSchema"] | null;
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    icon: c.icon,
    leadCap: c.leadCap,
    prohibited: c.prohibited,
    attributeSchema: schema && Array.isArray(schema.fields) ? schema : { fields: [] },
    parentId: c.parentId,
  };
}

/** Working-copy variant rows as seller variant views. */
export function toSellerVariants(rows: ListingRow["variants"]): SellerVariantView[] {
  return (rows ?? []).map((v) => ({
    id: v.id,
    sku: v.sku,
    axisValues: (v.axisValues && typeof v.axisValues === "object" && !Array.isArray(v.axisValues) ? v.axisValues : {}) as Record<string, string>,
    pricePaise: v.pricePaise === null ? null : Number(v.pricePaise),
    priceTiers: parsePriceTiers(v.priceTiers),
    moq: v.moq,
    availability: v.availability,
    availableQty: v.availableQty,
    leadTimeDays: v.leadTimeDays,
    imageId: v.imageId,
    sortOrder: v.sortOrder,
    stockUpdatedAt: v.stockUpdatedAt?.toISOString() ?? null,
  }));
}

export function toListingView(l: ListingRow): ListingView {
  const variants = toSellerVariants(l.variants);
  const own: Availability = l.availability ?? "in_stock";
  return {
    id: l.id,
    sellerBusinessId: l.sellerBusinessId,
    category: { id: l.category.id, slug: l.category.slug, name: l.category.name },
    availability: effectiveAvailability(own, variants),
    ownAvailability: own,
    availableQty: l.availableQty ?? null,
    stockUpdatedAt: l.stockUpdatedAt?.toISOString() ?? null,
    variantAxes: categoryAxes(l.category.attributeSchema as { variantAxes?: unknown } | null),
    variants,
    title: l.title,
    description: l.description,
    attributes: (l.attributes ?? {}) as Record<string, string | number>,
    pricePaise: l.pricePaise === null ? null : Number(l.pricePaise),
    priceUnit: l.priceUnit,
    moq: l.moq,
    moqUnit: l.moqUnit,
    hsn: l.hsn,
    priceTiers: parsePriceTiers(l.priceTiers),
    trade: tradeOfRow(l),
    language: l.language,
    sku: l.sku,
    // approved uploads first; falls back to the stored placeholder imageUrls when none are approved
    imageUrls: l.images.length ? l.images.map((i) => `/media/listing-images/${i.id}`) : l.imageUrls,
    aiGenerated: l.aiGenerated,
    status: l.status,
    moderationStatus: l.moderationStatus,
    moderationReason: l.moderationReason,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  };
}

/** Public image entry stored in LIVE (`live_listings.images`): same shape as PublicListingImage; `id` is null for placeholder urls. */
export interface LiveImage {
  id: string | null;
  src: string;
  srcSet: string;
  width: number;
  height: number;
  blurDataUrl: string | null;
  alt: string;
  sources: { type: string; srcSet: string }[];
}

/** A LIVE row as the public ListingView (always published + approved: that is the only thing LIVE contains). */
export function liveToListingView(l: LiveListing): ListingView {
  const images = Array.isArray(l.images) ? (l.images as unknown as LiveImage[]) : [];
  return {
    id: l.id,
    sellerBusinessId: l.sellerBusinessId,
    category: { id: l.categoryId, slug: l.categorySlug, name: l.categoryName },
    title: l.title,
    description: l.description,
    attributes: (l.attributes && typeof l.attributes === "object" && !Array.isArray(l.attributes) ? l.attributes : {}) as Record<string, string | number>,
    pricePaise: l.pricePaise === null ? null : Number(l.pricePaise),
    priceUnit: l.priceUnit,
    moq: l.moq,
    moqUnit: l.moqUnit,
    hsn: l.hsn,
    priceTiers: parsePriceTiers(l.priceTiers),
    trade: parseTrade(l.trade),
    language: l.language,
    imageUrls: images.map((i) => i.src),
    imageBlurs: images.map((i) => i.blurDataUrl ?? null),
    imageIds: images.map((i) => i.id ?? null),
    availability: (isAvailability(l.availability) ? l.availability : "in_stock") as Availability,
    availableQty: l.availableQty,
    stockUpdatedAt: l.stockUpdatedAt?.toISOString() ?? null,
    variantAxes: parseAxes(l.variantAxes),
    variants: parseVariants(l.variants),
    aiGenerated: l.aiGenerated,
    status: "published",
    moderationStatus: "approved",
    moderationReason: null,
    createdAt: l.firstPublishedAt.toISOString(),
    updatedAt: l.publishedAt.toISOString(),
    liveVersion: l.version,
    seller: { name: l.sellerName, city: l.sellerCity, state: l.sellerState, verificationTier: l.sellerTier, trustScore: l.sellerTrustScore, badgeActive: l.sellerBadgeActive },
  };
}
