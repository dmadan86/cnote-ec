// @cnote/reviews — product reviews, comments/Q&A and seller replies (ADR-003 trust, ADR-008 human-in-the-loop, ADR-010).
// All user-generated content is held for staff moderation (questions/answers: AI pre-screen, private until answered); only `approved` content is public and only
// approved reviews count toward ratings. Queries ONLY ProductReview, ProductComment, UgcReaction and
// ListingRatingSummary; other modules are reached through their public exports.
// PUBLIC CONTRACT. Extend, don't break.
export type {
  Actor, UgcStatus, UgcKind, ReviewSort, RatingSummary, Page, PublicReview, PublicComment, MyReview, MyComment, SellerUgcItem,
  ModerationItem, ModerationResult, ModerationSnapshot, PublicQuestion, QaPage, MyQuestion, SellerQuestion,
} from "./types";
export { TOMBSTONE_PERSON_ID, REPORT_THRESHOLD, isTombstone } from "./constants";

// writes (signed-in users; sellers reply)
export { submitReview, submitComment, replyToReview, replyToComment } from "./submit";
export { react, type ReactInput, type ReactionKind, type ReactionSubject } from "./react";
// product questions & answers (buyer asks, seller answers; public once answered and approved)
export { askQuestion, answerQuestion, type AnswerResult } from "./qa";
export { listPublicQuestions, listMyQuestions, listSellerQuestions, countUnansweredQuestions, type SellerQuestionFilters } from "./qa-read";
export { stripContact, questionInput, answerInput, type QuestionInput, type AnswerInput } from "./qa-validate";
export { QUESTION_MAX, QUESTION_MIN, ANSWER_MAX, ANSWER_MIN, QA_PAGE_SIZE } from "./constants";
export { reviewInput, commentInput } from "./validate";
export type { ReviewInput, CommentInput } from "./validate";

// public reads
export { listApprovedReviews, listApprovedComments, getMyReview, listMyPendingComments, listSellerUgc, type SellerUgcFilters } from "./read";
export { getRatingSummary, getRatingSummaries } from "./summary";
export { getSellerRatingSummaries, listApprovedSellerReviews, toSellerSummary, type SellerRatingSummary, type SellerReview } from "./seller";

// back office (call moderate() inside admin.audited(ctx, "ugc.moderate", ...))
export { listModerationQueue, getModerationItem, moderate, type QueueFilters } from "./moderation";

export { worker } from "./worker";

export * from "./getters";
export * from "./retention";

// DPDP access right: registered with @cnote/compliance's export registry (security audit M10).
export { exportPersonalData } from "./privacy";
