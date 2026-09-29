import { getListing } from "@cnote/catalogue";
import { currentSession } from "@cnote/next-kit";
import {
  type MyComment, type MyReview, type Page, type PublicComment, type PublicReview, type RatingSummary, type ReviewSort,
  getMyReview, getRatingSummary, listApprovedComments, listApprovedReviews, listMyPendingComments,
} from "@cnote/reviews";
import { Alert, Badge, EmptyState, buttonClasses } from "@cnote/ui";
import Link from "next/link";
import { CommentForm } from "./comment-form";
import { Histogram } from "./histogram";
import { ReactionButtons } from "./reaction-buttons";
import { ReviewCard } from "./review-card";
import { ReviewForm } from "./review-form";
import { Stars } from "./stars";

const SORTS: { value: ReviewSort; label: string }[] = [
  { value: "recent", label: "Most recent" },
  { value: "helpful", label: "Most helpful" },
  { value: "rating_high", label: "Highest rated" },
  { value: "rating_low", label: "Lowest rated" },
];
const isSort = (v: string | undefined): v is ReviewSort => SORTS.some((s) => s.value === v);

async function soft<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[web] reviews ${label} failed`, err instanceof Error ? err.message : err);
    return fallback;
  }
}

const date = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });
const EMPTY_SUMMARY = (listingId: string): RatingSummary => ({ listingId, count: 0, average: 0, histogram: [0, 0, 0, 0, 0] });

function MyReviewCard({ review }: { review: MyReview }) {
  return (
    <div className="space-y-2 rounded-card border border-line bg-canvas p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-ink">Your review</h3>
        {review.status === "approved" ? <Badge tone="success">Published</Badge> : null}
        {review.status === "pending" ? <Badge tone="warning">Awaiting approval</Badge> : null}
        {review.status === "rejected" ? <Badge tone="danger">Not approved</Badge> : null}
      </div>
      <Stars value={review.rating} />
      {review.title ? <p className="font-medium text-ink">{review.title}</p> : null}
      <p className="whitespace-pre-wrap text-sm text-ink">{review.body}</p>
      {review.status === "pending" ? <p className="text-xs text-muted">Your review is awaiting approval. It will show here for everyone once our team has checked it.</p> : null}
      {review.status === "rejected" ? <Alert tone="warning">Your review wasn&apos;t published{review.moderationNote ? `: ${review.moderationNote}` : "."} You can edit and resubmit it below.</Alert> : null}
    </div>
  );
}

function CommentItem({ c, listingId }: { c: Omit<PublicComment, "replies">; listingId: string }) {
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
 * Ratings, approved reviews, write-a-review, and the questions thread for one listing. Server Component.
 * Optional `sort` / `cursor` come from the page's search params (`?reviewSort=helpful&reviewCursor=10`).
 */
export async function ProductReviewsSection({ listingId, sort, cursor }: { listingId: string; sort?: string; cursor?: string }) {
  const session = await soft("session", () => currentSession(), null);
  const activeSort: ReviewSort = isSort(sort) ? sort : "recent";
  const [listing, summary, reviews, comments, mine, myComments] = await Promise.all([
    soft("listing", () => getListing(listingId), null),
    soft("summary", () => getRatingSummary(listingId), EMPTY_SUMMARY(listingId)),
    soft("reviews", () => listApprovedReviews(listingId, { sort: activeSort, cursor }), { items: [], nextCursor: null } as Page<PublicReview>),
    soft("comments", () => listApprovedComments(listingId), [] as PublicComment[]),
    session ? soft("mine", () => getMyReview(listingId, session.personId), null) : Promise.resolve(null),
    session ? soft("myComments", () => listMyPendingComments(listingId, session.personId), [] as MyComment[]) : Promise.resolve([] as MyComment[]),
  ]);

  const isSellerSide = !!session?.business && listing?.sellerBusinessId === session.business.id;
  const signIn = `/signin?next=${encodeURIComponent(`/products/${listingId}`)}`;
  const sortHref = (s: ReviewSort) => `?reviewSort=${s}#reviews`;

  return (
    <div className="space-y-10">
      <section id="reviews" aria-labelledby="reviews-h" className="space-y-5">
        <h2 id="reviews-h" className="text-xl font-bold text-ink">Ratings &amp; reviews</h2>

        {summary.count === 0 ? (
          <EmptyState title="No reviews yet" description="Be the first to share your experience with this product." />
        ) : (
          <div className="grid gap-6 sm:grid-cols-[12rem_1fr] sm:items-center">
            <div>
              <p className="text-4xl font-bold text-ink">{summary.average.toFixed(1)}<span className="text-base font-normal text-muted"> / 5</span></p>
              <Stars value={summary.average} className="text-xl" />
              <p className="mt-1 text-sm text-muted">{summary.count} rating{summary.count === 1 ? "" : "s"}</p>
            </div>
            <Histogram summary={summary} />
          </div>
        )}

        {/* write / edit */}
        {isSellerSide ? (
          <Alert tone="info">This is your own product, so you can&apos;t review it. Reply to buyers from the seller portal.</Alert>
        ) : !session ? (
          <div className="flex flex-wrap items-center gap-3">
            <Link href={signIn} className={buttonClasses("outline-brand", "md")}>Sign in to write a review</Link>
          </div>
        ) : (
          <div className="space-y-3">
            {mine ? <MyReviewCard review={mine} /> : null}
            <details className="rounded-card border border-line p-4" open={!mine}>
              <summary className="cursor-pointer text-sm font-semibold text-brand-700 focus-visible:outline-2 focus-visible:outline-brand-600">{mine ? "Edit your review" : "Write a review"}</summary>
              <div className="mt-4">
                {mine && mine.status === "approved" ? <Alert tone="info" className="mb-4">Editing a published review sends it back for approval and removes it from the rating until then.</Alert> : null}
                <ReviewForm listingId={listingId} initial={mine ?? undefined} />
              </div>
            </details>
          </div>
        )}

        {reviews.items.length > 0 ? (
          <div>
            <nav aria-label="Sort reviews" className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {SORTS.map((s) => (
                <Link key={s.value} href={sortHref(s.value)} scroll={false} aria-current={s.value === activeSort ? "true" : undefined} className={s.value === activeSort ? "font-semibold text-brand-700" : "text-muted hover:text-ink"}>
                  {s.label}
                </Link>
              ))}
            </nav>
            <div>{reviews.items.map((r) => <ReviewCard key={r.id} review={r} listingId={listingId} />)}</div>
            {reviews.nextCursor ? (
              <Link href={`?reviewSort=${activeSort}&reviewCursor=${reviews.nextCursor}#reviews`} className={buttonClasses("outline", "md", "mt-3")}>More reviews</Link>
            ) : null}
          </div>
        ) : null}
      </section>

      <section id="questions" aria-labelledby="questions-h" className="space-y-4">
        <h2 id="questions-h" className="text-xl font-bold text-ink">Questions &amp; answers</h2>
        {comments.length === 0 && myComments.length === 0 ? <EmptyState title="No questions yet" description="Ask the seller about specifications, pricing or delivery." /> : null}

        <ul className="space-y-5">
          {comments.map((c) => (
            <li key={c.id} className="space-y-3">
              <CommentItem c={c} listingId={listingId} />
              {c.replies.length ? (
                <ul className="ml-4 space-y-3 border-l-2 border-brand-100 pl-4">
                  {c.replies.map((r) => <li key={r.id}><CommentItem c={r} listingId={listingId} /></li>)}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>

        {myComments.length ? (
          <ul aria-label="Your questions" className="space-y-2">
            {myComments.map((c) => (
              <li key={c.id} className="rounded-card border border-line bg-canvas p-3 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">You</span>
                  {c.status === "rejected" ? <Badge tone="danger">Not approved</Badge> : <Badge tone="warning">Awaiting approval</Badge>}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-ink">{c.body}</p>
                {c.status === "rejected" && c.moderationNote ? <p className="mt-1 text-xs text-danger">{c.moderationNote}</p> : null}
              </li>
            ))}
          </ul>
        ) : null}

        {isSellerSide ? null : session ? (
          <CommentForm listingId={listingId} />
        ) : (
          <Link href={signIn} className={buttonClasses("outline-brand", "md")}>Sign in to ask a question</Link>
        )}
      </section>
    </div>
  );
}
