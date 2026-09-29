import type { PublicReview } from "@cnote/reviews";
import { Badge } from "@cnote/ui";
import { ReactionButtons } from "./reaction-buttons";
import { Stars } from "./stars";

const date = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

export function ReviewCard({ review, listingId }: { review: PublicReview; listingId: string }) {
  return (
    <article className="space-y-2 border-b border-line py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <Stars value={review.rating} />
        {review.title ? <h3 className="font-semibold text-ink">{review.title}</h3> : null}
      </div>
      <p className="text-xs text-muted">
        {review.authorName} · <time dateTime={review.createdAt}>{date(review.createdAt)}</time>
        {review.verifiedEnquiry ? <Badge tone="success" className="ml-2">Verified enquiry</Badge> : null}
      </p>
      <p className="whitespace-pre-wrap text-sm text-ink">{review.body}</p>
      {review.sellerReply ? (
        <div className="rounded-lg bg-canvas p-3 text-sm">
          <p className="font-medium text-ink">Response from the seller</p>
          <p className="mt-1 whitespace-pre-wrap text-ink">{review.sellerReply.body}</p>
        </div>
      ) : null}
      <ReactionButtons listingId={listingId} subjectType="review" subjectId={review.id} helpfulCount={review.helpfulCount} />
    </article>
  );
}
