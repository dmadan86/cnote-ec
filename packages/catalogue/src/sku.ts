import { prisma } from "@cnote/db";
import { listingInclude, toListingView } from "./mappers";
import type { ListingView } from "./index";

/** The seller's working-copy listing with this SKU (case-sensitive), or null. Basis of bulk upsert. */
export async function findSellerListingBySku(sellerBusinessId: string, sku: string): Promise<ListingView | null> {
  const row = await prisma.listing.findUnique({ where: { sellerBusinessId_sku: { sellerBusinessId, sku } }, include: listingInclude });
  return row ? toListingView(row) : null;
}

/** Batch lookup for bulk validation: SKU -> id/status for the seller's listings that use any of `skus`. */
export async function findSellerListingsBySkus(sellerBusinessId: string, skus: string[]): Promise<Map<string, { id: string; status: ListingView["status"] }>> {
  const out = new Map<string, { id: string; status: ListingView["status"] }>();
  for (let i = 0; i < skus.length; i += 1000) {
    const rows = await prisma.listing.findMany({ where: { sellerBusinessId, sku: { in: skus.slice(i, i + 1000) } }, select: { id: true, sku: true, status: true } });
    for (const r of rows) if (r.sku) out.set(r.sku, { id: r.id, status: r.status });
  }
  return out;
}
