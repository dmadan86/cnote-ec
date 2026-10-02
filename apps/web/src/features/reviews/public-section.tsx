import { EmptyState } from "@cnote/ui";
import { loadRatingSummary, loadReviewsPage } from "@/features/search/data";
import { Histogram } from "./histogram";
import { ReviewList } from "./review-list";
import { Stars } from "./stars";
import { ReviewsUserPanel } from "./user-panel";

/**
 * Cache-friendly reviews for the (ISR) product page: approved content only, no cookies, no query strings.
 * Rating summary and first page of reviews are in the static HTML (crawlers and LLMs read them);
 * the viewer-specific write forms are client islands. Purged by ReviewModerated via `reviews:<id>`. Product questions live in features/qa.
 */
export async function ProductReviewsStatic({ listingId }: { listingId: string }) {
  const [summary, reviews] = await Promise.all([loadRatingSummary(listingId), loadReviewsPage(listingId)]);
  return (
    <div className="space-y-10">
      <section id="reviews" aria-labelledby="reviews-h" className="space-y-5">
        <h2 id="reviews-h" className="text-xl font-bold text-ink">Ratings &amp; reviews</h2>
        {!summary || summary.count === 0 ? (
          <EmptyState title="No reviews yet" description="Be the first to share your experience with this product." />
        ) : (
          <div className="grid gap-6 sm:grid-cols-[12rem_1fr] sm:items-center">
            <div>
              <p className="text-4xl font-bold text-ink">
                {summary.average.toFixed(1)}
                <span className="text-base font-normal text-muted"> / 5</span>
              </p>
              <Stars value={summary.average} className="text-xl" />
              <p className="mt-1 text-sm text-muted">
                {summary.count} rating{summary.count === 1 ? "" : "s"}
              </p>
            </div>
            <Histogram summary={summary} />
          </div>
        )}
        <ReviewsUserPanel listingId={listingId} part="review" />
        <ReviewList listingId={listingId} initial={reviews} />
      </section>
    </div>
  );
}
