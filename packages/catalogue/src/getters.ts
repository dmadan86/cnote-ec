// Public lookups for other modules (notifications, admin, identity's GST checks).
import { prisma } from "@cnote/db";

/** id → title for the given listings (missing ids are absent from the map). */
export async function getListingTitles(ids: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids)].filter((i) => /^[0-9a-f-]{36}$/i.test(i));
  if (uniq.length === 0) return new Map();
  const rows = await prisma.listing.findMany({ where: { id: { in: uniq } }, select: { id: true, title: true } });
  return new Map(rows.map((r) => [r.id, r.title]));
}

/** Distinct HSN codes across a seller's non-archived listings (digits only), most frequent first. */
export async function getSellerListingHsns(sellerBusinessId: string): Promise<string[]> {
  const rows = await prisma.listing.findMany({
    where: { sellerBusinessId, hsn: { not: null }, status: { not: "archived" } },
    select: { hsn: true },
    take: 500,
  });
  const freq = new Map<string, number>();
  for (const r of rows) {
    const h = r.hsn?.replace(/\D/g, "");
    if (h) freq.set(h, (freq.get(h) ?? 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h);
}

export interface ShippingFacts {
  listingId: string;
  unitWeightGrams: number;
  unitLengthMm: number | null;
  unitWidthMm: number | null;
  unitHeightMm: number | null;
}

/**
 * Shipping weight/dimensions for the freight estimator (docs/design/freight-estimator.md): the seller's most recently updated
 * non-archived listing with a unit weight, preferring the given category slug. Null when the seller never entered one.
 */
export async function getSellerShippingFacts(sellerBusinessId: string, categorySlug?: string | null): Promise<ShippingFacts | null> {
  const base = { sellerBusinessId, unitWeightGrams: { not: null }, status: { not: "archived" as const } };
  const select = { id: true, unitWeightGrams: true, unitLengthMm: true, unitWidthMm: true, unitHeightMm: true };
  const row =
    (categorySlug ? await prisma.listing.findFirst({ where: { ...base, category: { slug: categorySlug } }, orderBy: { updatedAt: "desc" }, select }) : null) ??
    (await prisma.listing.findFirst({ where: base, orderBy: { updatedAt: "desc" }, select }));
  if (!row || row.unitWeightGrams == null) return null;
  return { listingId: row.id, unitWeightGrams: row.unitWeightGrams, unitLengthMm: row.unitLengthMm, unitWidthMm: row.unitWidthMm, unitHeightMm: row.unitHeightMm };
}
