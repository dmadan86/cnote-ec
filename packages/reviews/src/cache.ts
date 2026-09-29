import { cacheTags, invalidateTags } from "@cnote/core";

/** Post-commit invalidation of everything cached about a listing's public reviews/comments/rating. Never throws. */
export async function bustReviewCaches(listingId: string): Promise<void> {
  await invalidateTags([cacheTags.rating(listingId), cacheTags.reviews(listingId)]);
}

/** After an erasure (author names change to "Former user"): every cached review list is dropped. */
export async function bustAllReviewCaches(): Promise<void> {
  await invalidateTags([cacheTags.reviewsAll]);
}
