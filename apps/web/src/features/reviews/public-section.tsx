import { Badge, EmptyState } from "@cnote/ui";
import { loadComments, loadRatingSummary, loadReviewsPage } from "@/features/search/data";
import { Histogram } from "./histogram";
import { ReactionButtons } from "./reaction-buttons";
import { ReviewList } from "./review-list";
import { Stars } from "./stars";
import { ReviewsUserPanel } from "./user-panel";

const date = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

function CommentItem({ c, listingId }: { c: { id: string; body: string; authorName: string; isSeller: boolean; createdAt: string }; listingId: string }) {
  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className="font-medium text-ink">{c.authorName}</span>
        {c.isSeller ? <Badge tone="brand">Seller</Badge> : null}
        <time dateTime={c.createdAt}>{date(c.createdAt)}</time>
      </p>
      <p className="whitespace-pre-wrap text-sm text-ink">{c.body}</p>
      {!c.isSeller ? <ReactionButtons listingId={listingId} subjectType="comment" subjectId={c.id} /> : null}
    </div>
  );
}

/**
 * Cache-friendly reviews + Q&A for the (ISR) product page: approved content only, no cookies, no query strings.
 * Rating summary, first page of reviews and the Q&A thread are in the static HTML (crawlers and LLMs read them);
 * the viewer-specific write forms are client islands. Purged by ReviewModerated / CommentModerated via `reviews:<id>`.
 */
export async function ProductReviewsStatic({ listingId }: { listingId: string }) {
  const [summary, reviews, comments] = await Promise.all([loadRatingSummary(listingId), loadReviewsPage(listingId), loadComments(listingId)]);
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

      <section id="questions" aria-labelledby="questions-h" className="space-y-4">
        <h2 id="questions-h" className="text-xl font-bold text-ink">Questions &amp; answers</h2>
        {comments.length === 0 ? <EmptyState title="No questions yet" description="Ask the seller about specifications, pricing or delivery." /> : null}
        <ul className="space-y-5">
          {comments.map((c) => (
            <li key={c.id} className="space-y-3">
              <CommentItem c={c} listingId={listingId} />
              {c.replies.length ? (
                <ul className="ml-4 space-y-3 border-l-2 border-brand-100 pl-4">
                  {c.replies.map((r) => (
                    <li key={r.id}>
                      <CommentItem c={r} listingId={listingId} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
        <ReviewsUserPanel listingId={listingId} part="question" />
      </section>
    </div>
  );
}
