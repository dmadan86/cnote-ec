// Buyer-facing reviews UI.
// - <ProductReviewsStatic listingId /> is what the (ISR) product page mounts: cache-friendly, approved-only, per-user forms are client islands.
// - <ProductReviewsSection listingId sort? cursor? /> is the fully server-rendered, session-aware variant (dynamic; not for cached pages).
// - <RatingStars average count /> for product cards and search results (data from loadRatings() / getRatingSummaries()).
export { ProductReviewsSection } from "./section";
export { ProductReviewsStatic } from "./public-section";
export { RatingStars } from "./stars";
