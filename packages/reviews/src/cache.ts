import { cacheTags, invalidateTags } from "@cnote/core";

/** Tag on every cached seller-level review aggregate/list (moderation does not know the seller id, so it purges them all). */
export const SELLER_REVIEWS_TAG = "reviews:sellers";

/** Post-commit invalidation of everything cached about a listing's public reviews/comments/rating. Never throws. */
export async function bustReviewCaches(listingId: string): Promise<void> {
  await invalidateTags([cacheTags.rating(listingId), cacheTags.reviews(listingId), SELLER_REVIEWS_TAG]);
}

/** After an erasure (author names change to "Former user"): every cached review list is dropped. */
export async function bustAllReviewCaches(): Promise<void> {
  await invalidateTags([cacheTags.reviewsAll, SELLER_REVIEWS_TAG]);
}
