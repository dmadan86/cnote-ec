export type UgcStatus = "pending" | "flagged" | "approved" | "rejected";
export type UgcKind = "review" | "comment" | "reply" | "question" | "answer";
export type ReviewSort = "recent" | "helpful" | "rating_high" | "rating_low";

/** The signed-in person acting. `businessId` is their active business (session.business?.id), if any. */
export interface Actor {
  personId: string;
  businessId: string | null;
}

export interface RatingSummary {
  listingId: string;
  count: number;
  /** 0 when there are no ratings; otherwise one decimal place */
  average: number;
  /** counts for 1★ … 5★ (index 0 = 1★) */
  histogram: [number, number, number, number, number];
}

export interface Page<T> {
  items: T[];
  /** opaque; pass back as `cursor` */
  nextCursor: string | null;
}

export interface PublicReview {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  authorName: string;
  verifiedEnquiry: boolean;
  helpfulCount: number;
  createdAt: string;
  /** only when the reply itself was approved */
  sellerReply: { body: string; at: string } | null;
}

export interface PublicComment {
  id: string;
  body: string;
  authorName: string;
  isSeller: boolean;
  createdAt: string;
  replies: Omit<PublicComment, "replies">[];
}

/** What an author sees about their own submission. flagged is shown as pending (never reveal the AI screen). */
export interface MyReview {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  status: "pending" | "approved" | "rejected";
  moderationNote: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface MyComment {
  id: string;
  parentId: string | null;
  body: string;
  status: "pending" | "approved" | "rejected";
  moderationNote: string | null;
  createdAt: string;
}

export interface SellerUgcItem {
  kind: "review" | "comment";
  id: string;
  listingId: string;
  status: UgcStatus;
  rating: number | null;
  title: string | null;
  body: string;
  authorName: string;
  createdAt: string;
  /** review: the seller's reply. comment: the seller's latest thread reply. */
  reply: { id: string; body: string; status: UgcStatus; moderationNote: string | null } | null;
  needsReply: boolean;
}

export interface ModerationItem {
  kind: UgcKind;
  id: string;
  listingId: string;
  sellerBusinessId: string | null;
  status: UgcStatus;
  rating: number | null;
  title: string | null;
  body: string;
  /** the text being replied to (review body for a seller reply, parent comment for a thread reply) */
  context: string | null;
  isSeller: boolean;
  parentId: string | null;
  aiVerdict: string | null;
  reportCount: number;
  authorPersonId: string;
  authorBusinessId: string | null;
  moderationNote: string | null;
  createdAt: string;
}

export interface ModerationSnapshot {
  status: UgcStatus;
  moderationNote: string | null;
  reportCount: number;
}
export interface ModerationResult {
  kind: UgcKind;
  id: string;
  listingId: string;
  before: ModerationSnapshot;
  after: ModerationSnapshot;
}

// ---- product questions & answers ----

/** An answered, approved question as the public sees it. */
export interface PublicQuestion {
  id: string;
  body: string;
  authorName: string;
  askedAt: string;
  answer: { id: string; body: string; answeredAt: string; sellerName: string; helpfulCount: number };
}
export interface QaPage extends Page<PublicQuestion> {
  /** all answered questions matching the filter (not just this page) */
  total: number;
}

/** What an asker sees about their own question. flagged is shown as pending (never reveal the AI screen). */
export interface MyQuestion {
  id: string;
  body: string;
  status: "pending" | "approved" | "rejected";
  moderationNote: string | null;
  piiStripped: boolean;
  createdAt: string;
  /** the approved answer, once there is one (then the question is public too) */
  answer: { body: string; answeredAt: string } | null;
}

/** Seller inbox row: an approved-for-seller question plus the seller's own answer in any moderation state. */
export interface SellerQuestion {
  id: string;
  listingId: string;
  body: string;
  authorName: string;
  createdAt: string;
  answer: { id: string; body: string; status: UgcStatus; moderationNote: string | null } | null;
  /** no answer yet, or the answer was rejected */
  needsAnswer: boolean;
}
