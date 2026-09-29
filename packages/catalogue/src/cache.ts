import { cacheTags, invalidateTags, softInvalidateTags } from "@cnote/core";

/**
 * Post-commit cache invalidation for listing writes. Hard-invalidates every cached view of the listing
 * (so a rejected/archived/edited listing can never be served from cache) and softly refreshes the ranked
 * collections (featured rails, search results) that may now include or exclude it. Never throws.
 */
export async function bustListingCaches(listingId: string, sellerBusinessId?: string | null): Promise<void> {
  await invalidateTags([cacheTags.listing(listingId), ...(sellerBusinessId ? [cacheTags.sellerListings(sellerBusinessId)] : []), cacheTags.sitemap]);
  await softInvalidateTags([cacheTags.featured, cacheTags.search]);
}
