import type { Prisma } from "@cnote/db";
import type { CategoryView, ListingView } from "./index";

export const listingInclude = {
  category: { select: { id: true, slug: true, name: true } },
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

export function toListingView(l: ListingRow): ListingView {
  return {
    id: l.id,
    sellerBusinessId: l.sellerBusinessId,
    category: l.category,
    title: l.title,
    description: l.description,
    attributes: (l.attributes ?? {}) as Record<string, string | number>,
    pricePaise: l.pricePaise === null ? null : Number(l.pricePaise),
    priceUnit: l.priceUnit,
    moq: l.moq,
    moqUnit: l.moqUnit,
    hsn: l.hsn,
    language: l.language,
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
