"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { MyComment, MyReview } from "@cnote/reviews";
import { Alert, Badge, buttonClasses } from "@cnote/ui";
import { CommentForm } from "./comment-form";
import { ReviewForm } from "./review-form";
import { Stars } from "./stars";

interface ViewerState {
  signedIn: boolean;
  isSellerSide: boolean;
  mine: MyReview | null;
  myComments: MyComment[];
}

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

/** Viewer-specific write area of the reviews section (per-user, so it is a client island, never in cached HTML). */
export function ReviewsUserPanel({ listingId, part }: { listingId: string; part: "review" | "question" }) {
  const [v, setV] = useState<ViewerState | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/me/product/${listingId}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<ViewerState>) : null))
      .then((d) => live && setV(d ?? { signedIn: false, isSellerSide: false, mine: null, myComments: [] }))
      .catch(() => live && setV({ signedIn: false, isSellerSide: false, mine: null, myComments: [] }));
    return () => {
      live = false;
    };
  }, [listingId]);

  const signIn = `/signin?next=${encodeURIComponent(typeof window === "undefined" ? "/" : window.location.pathname)}`;
  if (!v) return <div className="min-h-11" aria-hidden />; // reserve space; nothing personal is rendered until known

  if (part === "review") {
    if (v.isSellerSide) return <Alert tone="info">This is your own product, so you can&apos;t review it. Reply to buyers from the seller portal.</Alert>;
    if (!v.signedIn) {
      return (
        <div className="flex flex-wrap items-center gap-3">
          <Link href={signIn} className={buttonClasses("outline-brand", "md")}>
            Sign in to write a review
          </Link>
        </div>
      );
    }
    return (
      <div className="space-y-3">
        {v.mine ? <MyReviewCard review={v.mine} /> : null}
        <details className="rounded-card border border-line p-4" open={!v.mine}>
          <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-brand-700 focus-visible:outline-2 focus-visible:outline-brand-600">{v.mine ? "Edit your review" : "Write a review"}</summary>
          <div className="mt-4">
            {v.mine && v.mine.status === "approved" ? <Alert tone="info" className="mb-4">Editing a published review sends it back for approval and removes it from the rating until then.</Alert> : null}
            <ReviewForm listingId={listingId} initial={v.mine ?? undefined} />
          </div>
        </details>
      </div>
    );
  }

  return (
    <>
      {v.myComments.length ? (
        <ul aria-label="Your questions" className="space-y-2">
          {v.myComments.map((c) => (
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
      {v.isSellerSide ? null : v.signedIn ? (
        <CommentForm listingId={listingId} />
      ) : (
        <Link href={signIn} className={buttonClasses("outline-brand", "md")}>
          Sign in to ask a question
        </Link>
      )}
    </>
  );
}
