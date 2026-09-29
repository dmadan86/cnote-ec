// Versioned domain event catalogue (ADR-007). This is the cross-module contract: modules emit and
// consume only these shapes. Changing a payload = add a new version; never mutate an old one.
// Money in payloads is integer paise as `number` (JSON has no bigint).

export interface DomainEventPayloads {
  // identity
  PersonRegistered: { personId: string; phone: string };
  BusinessCreated: { businessId: string; personId: string; isSeller: boolean };
  BusinessVerified: { businessId: string; tier: number; kind: string };
  TrustScoreChanged: { businessId: string; from: number; to: number; badgeActive: boolean };
  ConsentChanged: { personId: string; purpose: string; granted: boolean };
  DataErasureRequested: { personId: string };
  // catalogue
  ListingPublished: { listingId: string; sellerBusinessId: string; categoryId: string };
  ListingModerated: { listingId: string; sellerBusinessId: string; status: "approved" | "review" | "rejected"; reason?: string };
  ListingArchived: { listingId: string; sellerBusinessId: string };
  ListingImageUploaded: { imageId: string; listingId: string; sellerBusinessId: string; aiVerdict: string | null };
  ListingImageProcessed: { imageId: string; listingId: string; variants: number };
  ListingImageModerated: { imageId: string; listingId: string; sellerBusinessId: string; status: "approved" | "rejected"; moderatedBy: string };
  // enquiry & matching
  EnquiryCreated: { enquiryId: string; buyerBusinessId: string; categoryId: string | null };
  EnquiryScored: { enquiryId: string; intentScore: number; needsReview: boolean };
  LeadMatched: { enquiryId: string; matchId: string; sellerBusinessId: string; rank: number; matchScore: number };
  LeadAccepted: { enquiryId: string; matchId: string; sellerBusinessId: string; creditTxnId: string | null; responseMs: number };
  LeadDeclined: { enquiryId: string; matchId: string; sellerBusinessId: string; reason?: string };
  LeadExpired: { enquiryId: string; matchId: string; sellerBusinessId: string };
  LeadRefunded: { enquiryId: string; matchId: string; sellerBusinessId: string; reason: "buyer_unreachable" | "buyer_fake" | "enquiry_rejected" };
  ConversationStarted: { conversationId: string; matchId: string };
  MessageSent: { conversationId: string; messageId: string; senderPersonId: string };
  QuoteSent: { quoteId: string; conversationId: string; sellerBusinessId: string; pricePaise: number; quantity: number };
  DealReportedOffPlatform: { matchId: string; reportedByBusinessId: string; outcome: "won" | "lost" | "pending"; valuePaise?: number };
  // reviews (user-generated content; public only after staff approval)
  ReviewSubmitted: { reviewId: string; listingId: string; sellerBusinessId: string; authorPersonId: string; rating: number; aiVerdict: string | null };
  ReviewModerated: { reviewId: string; listingId: string; sellerBusinessId: string; status: "approved" | "rejected"; rating: number; moderatedBy: string };
  CommentSubmitted: { commentId: string; listingId: string; parentId: string | null; authorPersonId: string; isSeller: boolean; aiVerdict: string | null };
  CommentModerated: { commentId: string; listingId: string; status: "approved" | "rejected"; moderatedBy: string };
  // wishlist (demand signal for sellers/search; no PII beyond ids)
  WishlistItemAdded: { wishlistId: string; personId: string; listingId: string };
  WishlistItemRemoved: { wishlistId: string; personId: string; listingId: string };
  // storefronts (seller mini-sites)
  StorefrontPublished: { storefrontId: string; sellerBusinessId: string; slug: string; versionId: string };
  StorefrontVersionReviewed: { storefrontId: string; sellerBusinessId: string; versionId: string; status: "published" | "rejected"; reviewedBy: string };
  StorefrontSuspended: { storefrontId: string; sellerBusinessId: string; reason: string };
  StorefrontDomainStatusChanged: { domainId: string; storefrontId: string; sellerBusinessId: string; hostname: string; from: string; to: string; error: string | null };
  // lead generation (buyer unlock funnel)
  LeadCaptureVerified: { captureId: string; personId: string; trigger: string; unlock: string; listingId: string | null; isNewPerson: boolean };
  LeadCaptureConverted: { captureId: string; personId: string; trigger: string; enquiryId: string | null };
  // billing
  CreditsGranted: { businessId: string; amount: number; reason: string; expiresAt: string };
  CreditConsumed: { businessId: string; txnId: string; refType: string; refId: string };
  CreditRefunded: { businessId: string; txnId: string; refType: string; refId: string };
  SubscriptionStarted: { businessId: string; subscriptionId: string; planCode: string };
  SubscriptionCancelled: { businessId: string; subscriptionId: string; planCode: string };
}

export type DomainEventType = keyof DomainEventPayloads;

/** Current schema version per event type. Bump when a payload shape changes. */
export const EVENT_VERSIONS: { [K in DomainEventType]: number } = {
  PersonRegistered: 1,
  BusinessCreated: 1,
  BusinessVerified: 1,
  TrustScoreChanged: 1,
  ConsentChanged: 1,
  DataErasureRequested: 1,
  ListingPublished: 1,
  ListingModerated: 1,
  ListingArchived: 1,
  ListingImageUploaded: 1,
  ListingImageModerated: 1,
  ListingImageProcessed: 1,
  EnquiryCreated: 1,
  EnquiryScored: 1,
  LeadMatched: 1,
  LeadAccepted: 1,
  LeadDeclined: 1,
  LeadExpired: 1,
  LeadRefunded: 1,
  ConversationStarted: 1,
  MessageSent: 1,
  QuoteSent: 1,
  DealReportedOffPlatform: 1,
  ReviewSubmitted: 1,
  ReviewModerated: 1,
  CommentSubmitted: 1,
  CommentModerated: 1,
  WishlistItemAdded: 1,
  WishlistItemRemoved: 1,
  StorefrontPublished: 1,
  StorefrontVersionReviewed: 1,
  StorefrontSuspended: 1,
  StorefrontDomainStatusChanged: 1,
  LeadCaptureVerified: 1,
  LeadCaptureConverted: 1,
  CreditsGranted: 1,
  CreditConsumed: 1,
  CreditRefunded: 1,
  SubscriptionStarted: 1,
  SubscriptionCancelled: 1,
};

export interface DomainEvent<T extends DomainEventType = DomainEventType> {
  id: number;
  type: T;
  version: number;
  aggregateType: string;
  aggregateId: string;
  payload: DomainEventPayloads[T];
  occurredAt: string;
}
