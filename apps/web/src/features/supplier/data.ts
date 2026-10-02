import "server-only";
import { unstable_cache } from "next/cache";
import { listPublicSellerListings } from "@cnote/catalogue";
import { cacheTags } from "@cnote/core";
import { getSupplierResponseStats } from "@cnote/enquiry";
import { getVerificationEvidence } from "@cnote/identity";
import { getSellerRatingSummaries, listApprovedSellerReviews, type Page, type SellerReview } from "@cnote/reviews";
import { getLiveStorefrontSlugs } from "@cnote/storefront";
import { safe } from "@/features/search/data";
import { buildSupplierTrust, type SupplierTrust } from "./model";

/**
 * Public supplier trust read model (ADR-003 / ADR-002): one aggregate per seller, joined from the modules that own
 * each fact (identity evidence, enquiry response stats, reviews, catalogue count, storefront). Two cache tiers like the
 * other public reads: Redis inside every module, then the Next data cache here, so the ISR pages stay static.
 * Per-seller entries (never keyed by viewer); purged by `seller:<id>` / `seller-listings:<id>`.
 */
const REVALIDATE = 300;

async function loadOne(sellerId: string): Promise<SupplierTrust | null> {
  const [evidence, response, rating, listings, storefront] = await Promise.all([
    getVerificationEvidence([sellerId]),
    getSupplierResponseStats([sellerId]),
    getSellerRatingSummaries([sellerId]),
    listPublicSellerListings(sellerId),
    getLiveStorefrontSlugs([sellerId]),
  ]);
  const e = evidence.get(sellerId);
  if (!e) return null;
  return buildSupplierTrust({ evidence: e, response: response.get(sellerId), rating: rating.get(sellerId), liveListings: listings.length, storefrontSlug: storefront.get(sellerId) ?? null });
}

export function loadSupplierTrust(sellerId: string): Promise<SupplierTrust | null> {
  return safe(
    "supplier.trust",
    () => unstable_cache(() => loadOne(sellerId), ["web", "supplier-trust", sellerId], { tags: [cacheTags.seller(sellerId), cacheTags.sellerListings(sellerId)], revalidate: REVALIDATE })(),
    null,
  );
}

/** Trust aggregates for several sellers (compare table, cards). Missing / failed sellers are simply absent. */
export async function loadSupplierTrustMany(sellerIds: string[]): Promise<Record<string, SupplierTrust>> {
  const ids = [...new Set(sellerIds)];
  const all = await Promise.all(ids.map((id) => loadSupplierTrust(id)));
  return Object.fromEntries(all.flatMap((t, i) => (t ? [[ids[i]!, t] as const] : [])));
}

/** Approved reviews across the seller's listings (first page; the profile shows the aggregate + latest reviews). */
export function loadSellerReviews(sellerId: string, limit = 10): Promise<Page<SellerReview>> {
  return safe(
    "reviews.listApprovedSellerReviews",
    () => unstable_cache(() => listApprovedSellerReviews(sellerId, { limit }), ["web", "seller-reviews", sellerId, String(limit)], { tags: [cacheTags.seller(sellerId), cacheTags.reviewsAll], revalidate: 120 })(),
    { items: [], nextCursor: null } as Page<SellerReview>,
  );
}
