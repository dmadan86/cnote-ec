import { getListing, type ListingView } from "@cnote/catalogue";
import { DomainError, emit, rateLimit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { COMMENTS_PER_HOUR, REVIEWS_PER_DAY } from "./constants";
import { authorStatus, screenText } from "./screen";
import { bustReviewCaches } from "./cache";
import { recomputeSummary } from "./summary";
import type { Actor, MyComment, MyReview, UgcStatus } from "./types";
import { commentInput, replyInput, reviewInput, type CommentInput, type ReviewInput } from "./validate";
import { hasVerifiedEnquiry } from "./verified";

const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

async function publishedListing(listingId: string): Promise<ListingView> {
  const listing = await getListing(listingId);
  if (!listing || listing.status !== "published") throw new DomainError("not_found", "This product is not available.");
  return listing;
}
const isSellerSide = (actor: Actor, sellerBusinessId: string) => actor.businessId !== null && actor.businessId === sellerBusinessId;

async function limit(key: string, max: number, windowSeconds: number, msg: string) {
  if (!(await rateLimit(key, max, windowSeconds))) throw new DomainError("rate_limited", msg);
}

const toMyReview = (r: { id: string; rating: number; title: string | null; body: string; status: UgcStatus; moderationNote: string | null; createdAt: Date; updatedAt: Date }): MyReview => ({
  id: r.id, rating: r.rating, title: r.title, body: r.body, status: authorStatus(r.status),
  moderationNote: r.status === "rejected" ? r.moderationNote : null,
  createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
});
export { toMyReview };

/**
 * Create or edit the actor's review of a listing (one per listing per person). Every write goes
 * back to pending (or flagged by the AI pre-screen); it is public only after staff approve it.
 * Editing an approved review removes it from the aggregate until re-approved.
 */
export async function submitReview(actor: Actor, listingId: string, rawInput: ReviewInput): Promise<MyReview> {
  const input = reviewInput.parse(rawInput);
  const listing = await publishedListing(listingId);
  if (isSellerSide(actor, listing.sellerBusinessId)) throw new DomainError("forbidden", "You can't review your own product.");
  await limit(`reviews:submit:${actor.personId}`, REVIEWS_PER_DAY, 86_400, "You've reached today's review limit. Please try again tomorrow.");

  const verifiedEnquiry = await hasVerifiedEnquiry(actor.businessId, listing.sellerBusinessId);
  const reviewId = randomUUID();
  const screen = await screenText(`${input.title ?? ""}\n${input.body}`.trim(), reviewId);

  try {
    const row = await prisma.$transaction(async (tx) => {
      const existing = await tx.productReview.findUnique({ where: { listingId_authorPersonId: { listingId, authorPersonId: actor.personId } } });
      const data = {
        rating: input.rating, title: input.title, body: input.body, language: input.language, verifiedEnquiry,
        authorBusinessId: actor.businessId, status: screen.status, aiVerdict: screen.aiVerdict, aiDecisionId: screen.aiDecisionId,
        moderationNote: null, moderatedBy: null, moderatedAt: null,
      };
      const saved = existing
        ? await tx.productReview.update({ where: { id: existing.id }, data })
        : await tx.productReview.create({ data: { id: reviewId, listingId, sellerBusinessId: listing.sellerBusinessId, authorPersonId: actor.personId, ...data } });
      if (existing?.status === "approved") await recomputeSummary(tx, listingId);
      await emit(tx, "ReviewSubmitted", { type: "review", id: saved.id }, {
        reviewId: saved.id, listingId, sellerBusinessId: listing.sellerBusinessId, authorPersonId: actor.personId, rating: saved.rating, aiVerdict: screen.aiVerdict,
      });
      return saved;
    });
    await bustReviewCaches(listingId); // an edited approved review leaves the public list/aggregate until re-approved
    return toMyReview(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new DomainError("conflict", "You've already reviewed this product. Refresh to edit your review.");
    throw e;
  }
}

/**
 * Post a question/comment, or (with parentId) a seller reply in a thread. Threads are one level
 * deep and only members of the listing's seller business may reply, to an approved comment.
 */
export async function submitComment(actor: Actor, listingId: string, rawInput: CommentInput): Promise<MyComment> {
  const input = commentInput.parse(rawInput);
  const listing = await publishedListing(listingId);
  const isSeller = isSellerSide(actor, listing.sellerBusinessId);

  if (input.parentId) {
    if (!isSeller) throw new DomainError("forbidden", "Only the seller can reply to a question.");
    const parent = await prisma.productComment.findUnique({ where: { id: input.parentId }, select: { listingId: true, parentId: true, status: true } });
    if (!parent || parent.listingId !== listingId) throw new DomainError("not_found", "That question no longer exists.");
    if (parent.parentId) throw new DomainError("validation", "Replies can't be nested.", undefined, "reviews.repliesCantNested");
    if (parent.status !== "approved") throw new DomainError("conflict", "That question isn't public yet.", undefined, "reviews.questionIsntPublicYet");
  }
  await limit(`reviews:comment:${actor.personId}`, COMMENTS_PER_HOUR, 3_600, "You're posting too quickly. Please wait a little and try again.");

  const commentId = randomUUID();
  const screen = await screenText(input.body, commentId);
  const row = await prisma.$transaction(async (tx) => {
    const saved = await tx.productComment.create({
      data: {
        id: commentId, listingId, parentId: input.parentId ?? null, authorPersonId: actor.personId, authorBusinessId: actor.businessId,
        isSeller, body: input.body, language: input.language, status: screen.status, aiVerdict: screen.aiVerdict, aiDecisionId: screen.aiDecisionId,
      },
    });
    await emit(tx, "CommentSubmitted", { type: "comment", id: saved.id }, {
      commentId: saved.id, listingId, parentId: saved.parentId, authorPersonId: actor.personId, isSeller, aiVerdict: screen.aiVerdict,
    });
    return saved;
  });
  return { id: row.id, parentId: row.parentId, body: row.body, status: authorStatus(row.status), moderationNote: null, createdAt: row.createdAt.toISOString() };
}

/** Seller reply to an approved review. The reply is moderated like other UGC; a new reply replaces the old one. */
export async function replyToReview(actor: Actor, reviewId: string, rawBody: string): Promise<void> {
  const { body } = replyInput.parse({ body: rawBody });
  const review = await prisma.productReview.findUnique({ where: { id: reviewId } });
  if (!review || review.status !== "approved") throw new DomainError("not_found", "Review not found.", undefined, "account.reviewNotFound");
  if (!isSellerSide(actor, review.sellerBusinessId)) throw new DomainError("forbidden", "Only the seller can reply to this review.");
  await limit(`reviews:comment:${actor.personId}`, COMMENTS_PER_HOUR, 3_600, "You're posting too quickly. Please wait a little and try again.");
  const screen = await screenText(body, review.id);
  await prisma.productReview.update({
    where: { id: review.id },
    data: { sellerReply: body, sellerReplyStatus: screen.status, sellerRepliedAt: new Date() },
  });
  await bustReviewCaches(review.listingId); // a replaced reply is hidden until re-approved
}

/** Seller reply in a question thread (isSeller=true, pending). Convenience over submitComment(parentId). */
export async function replyToComment(actor: Actor, commentId: string, body: string): Promise<MyComment> {
  const parent = await prisma.productComment.findUnique({ where: { id: commentId }, select: { listingId: true } });
  if (!parent) throw new DomainError("not_found", "That question no longer exists.");
  return submitComment(actor, parent.listingId, { body, parentId: commentId });
}
