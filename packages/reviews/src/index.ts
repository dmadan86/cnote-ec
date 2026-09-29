// @cnote/reviews — product reviews, comments/Q&A and seller replies (ADR-003 trust, ADR-008 human-in-the-loop, ADR-010).
// All user-generated content is held for staff moderation; only `approved` content is public and only
// approved reviews count toward ratings. Queries ONLY ProductReview, ProductComment, UgcReaction and
// ListingRatingSummary; other modules are reached through their public exports.
// PUBLIC CONTRACT. Extend, don't break.
export type {
  Actor, UgcStatus, UgcKind, ReviewSort, RatingSummary, Page, PublicReview, PublicComment, MyReview, MyComment, SellerUgcItem,
  ModerationItem, ModerationResult, ModerationSnapshot,
} from "./types";
export { TOMBSTONE_PERSON_ID, REPORT_THRESHOLD, isTombstone } from "./constants";

// writes (signed-in users; sellers reply)
export { submitReview, submitComment, replyToReview, replyToComment } from "./submit";
export { react, type ReactInput, type ReactionKind } from "./react";
export { reviewInput, commentInput } from "./validate";
export type { ReviewInput, CommentInput } from "./validate";

// public reads
export { listApprovedReviews, listApprovedComments, getMyReview, listMyPendingComments, listSellerUgc, type SellerUgcFilters } from "./read";
export { getRatingSummary, getRatingSummaries } from "./summary";

// back office (call moderate() inside admin.audited(ctx, "ugc.moderate", ...))
export { listModerationQueue, getModerationItem, moderate, type QueueFilters } from "./moderation";

export { worker } from "./worker";

export * from "./getters";
