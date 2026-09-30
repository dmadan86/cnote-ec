import { cacheTags } from "@cnote/core";
import { getActivePromotions, getOfferForListing, promoTags, type PromotionSurfaceName, type PublicOffer, type PublicPromotion } from "@cnote/promotions";
import { unstable_cache } from "next/cache";

// Public promotion + offer reads for static pages. Cached in the Next data cache with the same tags the promotions worker purges
// (POST /api/revalidate), so approving/pulling a banner or ending an offer reaches these pages without a redeploy.
// Every read fails soft: a promotions outage renders the page without promotions, never an error.
export async function loadPromotions(surface: PromotionSurfaceName, locale: string): Promise<PublicPromotion[]> {
  try {
    return await unstable_cache(() => getActivePromotions({ surface, locale }), ["web", "promo", surface, locale], { tags: [promoTags.all, promoTags.surface(surface)], revalidate: 300 })();
  } catch (err) {
    console.error("[web] promotions failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

export async function loadOffer(listingId: string): Promise<PublicOffer | null> {
  try {
    return await unstable_cache(() => getOfferForListing(listingId), ["web", "offer", listingId], { tags: [promoTags.offer(listingId), cacheTags.listing(listingId), promoTags.offers], revalidate: 120 })();
  } catch (err) {
    console.error("[web] offer failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Offers for a card grid, keyed by listing id. Per-listing cache entries, so one offer ending purges one entry. */
export async function loadOffers(listingIds: string[]): Promise<Record<string, PublicOffer>> {
  const offers = await Promise.all(listingIds.map((id) => loadOffer(id)));
  const out: Record<string, PublicOffer> = {};
  offers.forEach((o, i) => void (o && (out[listingIds[i]!] = o)));
  return out;
}
