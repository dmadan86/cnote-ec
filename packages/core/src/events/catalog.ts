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
  ListingVersionSubmitted: { listingId: string; versionId: string; version: number; sellerBusinessId: string; aiVerdict: string | null };
  ListingVersionReviewed: { listingId: string; versionId: string; version: number; sellerBusinessId: string; status: "approved" | "rejected"; reviewedBy: string | null };
  /** Emitted by the publisher after the live DB projection commits. */
  ListingVersionPublished: { listingId: string; versionId: string; version: number; sellerBusinessId: string; previousVersionId: string | null };
  ListingUnpublished: { listingId: string; sellerBusinessId: string; reason: string };
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
  // bulk import / export
  BulkJobFinished: { jobId: string; sellerBusinessId: string; createdBy: string; kind: "import" | "export"; status: string; created: number; updated: number; errors: number };
  // lead generation (buyer unlock funnel)
  LeadCaptureVerified: { captureId: string; personId: string; trigger: string; unlock: string; listingId: string | null; isNewPerson: boolean };
  LeadCaptureConverted: { captureId: string; personId: string; trigger: string; enquiryId: string | null };
  // orders (ADR-007 stub; off-platform in Phase 1)
  OrderRecorded: { orderId: string; matchId: string; enquiryId: string; buyerBusinessId: string; sellerBusinessId: string; totalPaise: number | null };
  OrderStatusChanged: { orderId: string; buyerBusinessId: string; sellerBusinessId: string; from: string; to: string };
  // compliance (ADR-010)
  GrievanceFiled: { ticketId: string; personId: string | null; category: string; dueAt: string };
  GrievanceResolved: { ticketId: string; personId: string | null; status: "resolved" | "rejected" };
  AppealFiled: { appealId: string; personId: string; subjectType: string; subjectId: string };
  AppealDecided: { appealId: string; personId: string; subjectType: string; subjectId: string; status: "resolved" | "rejected" };
  // voice + WhatsApp onboarding (ADR-004)
  VoiceNoteTranscribed: { voiceNoteId: string; sellerBusinessId: string; listingId: string | null; language: string | null };
  WhatsAppOnboardingCompleted: { contactId: string; personId: string; businessId: string; listingId: string | null };
  // ads (ADR-024)
  AdCampaignSubmitted:     { campaignId: string; sellerBusinessId: string; objective: "enquiries" | "visibility"; dailyBudgetPaise: number; createdByStaff: boolean };
  AdCampaignReviewed:      { campaignId: string; sellerBusinessId: string; decision: "approved" | "rejected"; reviewedBy: string; reasonCode?: string; note?: string };
  AdCampaignStatusChanged: { campaignId: string; sellerBusinessId: string; from: string; to: string; cause: "seller" | "staff" | "budget" | "wallet" | "eligibility" | "schedule" };
  AdBudgetExhausted:       { campaignId: string; sellerBusinessId: string; istDate: string; spentPaise: number; dailyBudgetPaise: number };
  AdIneligible:            { listingId: string; sellerBusinessId: string; campaignId: string; reason: string }; // trust_below_floor | listing_unpublished | no_approved_image | category_prohibited | ...
  AdWalletToppedUp:        { businessId: string; topUpId: string; amountPaise: number; gstPaise: number; invoiceNumber: string };
  AdWalletLow:             { businessId: string; balancePaise: number; thresholdPaise: number };
  AdClicked:               { clickId: string; campaignId: string; adGroupId: string; listingId: string; sellerBusinessId: string; surface: string; slot: number; chargedPaise: number; validity: "valid" | "pending" | "invalid" | "self_click"; invalidReason?: string };
  AdClickInvalidated:      { clickId: string; campaignId: string; sellerBusinessId: string; reason: string; refundedPaise: number; source: "rules" | "rescore" | "staff" };
  AdSpendSettled:          { settlementId: string; campaignId: string; sellerBusinessId: string; windowStart: string; windowEnd: string; validClicks: number; spendPaise: number };
  AdImpressionsRolledUp:   { hour: string; campaignId: string; surface: string; served: number; lostBudget: number; lostQuality: number }; // one per campaign per surface per hour, not per impression
  AdAttributionRecorded:   { attributionId: string; clickId: string; campaignId: string; listingId: string; enquiryId: string; lagSeconds: number };
  // promotions (ADR-025)
  PromotionPublished:      { promotionId: string; kind: string; surfaces: string[]; startsAt: string; endsAt: string; createdBy: string; approvedBy: string };
  PromotionArchived:       { promotionId: string; reason: string; archivedBy: string };
  OfferCreated:            { offerId: string; listingId: string; sellerBusinessId: string; kind: "volume_tiers" | "timed_price" | "free_delivery_moq"; needsReview: boolean };
  OfferActivated:          { offerId: string; listingId: string; sellerBusinessId: string; referencePricePaise: number | null; discountBps: number | null; startsAt: string; endsAt: string | null };
  OfferRejected:           { offerId: string; listingId: string; sellerBusinessId: string; reason: string; reviewedBy?: string };
  OfferEnded:              { offerId: string; listingId: string; sellerBusinessId: string; reason: "expired" | "cancelled" | "listing_changed" | "suspended" };
  OfferHonourReported:     { reportId: string; offerId: string; sellerBusinessId: string; reportedByBusinessId: string };
  OfferHonourDecided:      { reportId: string; offerId: string; sellerBusinessId: string; upheld: boolean };
  CouponRedeemed:          { couponId: string; redemptionId: string; businessId: string; planCode: string | null; discountPaise: number; creditsGranted: number };
  CouponVoided:            { couponId: string; redemptionId: string; businessId: string; reason: string };
  ReferralQualified:       { referralId: string; referrerBusinessId: string; refereeBusinessId: string; action: "listing_published" | "first_verified_enquiry"; holdUntil: string };
  ReferralRewarded:        { referralId: string; referrerBusinessId: string; refereeBusinessId: string; creditsEach: number };
  ReferralRejected:        { referralId: string; referrerBusinessId: string; refereeBusinessId: string; reason: string };
  // payments + invoicing (ADR-001/005)
  PaymentSucceeded: { paymentOrderId: string; businessId: string; purpose: string; totalPaise: number; invoiceNumber: string | null };
  PaymentFailed: { paymentOrderId: string; businessId: string; purpose: string; reason: string };
  PaymentRefunded: { paymentOrderId: string; businessId: string; amountPaise: number; creditNoteNumber: string | null };
  // T2/T3 verification (ADR-003)
  KycSubmitted: { sessionId: string; businessId: string; provider: string };
  KycDecided: { sessionId: string; businessId: string; status: "approved" | "rejected" | "review"; decidedBy: string | null };
  AuditCompleted: { auditId: string; businessId: string; result: "pass" | "fail" | "conditional"; validUntil: string | null };
  // buyer reachability (ADR-002)
  ReachabilityChecked: { checkId: string; enquiryId: string; matchId: string | null; channel: string; status: "responded" | "no_response" | "failed" };
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
  ListingVersionSubmitted: 1,
  ListingVersionReviewed: 1,
  ListingVersionPublished: 1,
  ListingUnpublished: 1,
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
  BulkJobFinished: 1,
  LeadCaptureVerified: 1,
  LeadCaptureConverted: 1,
  OrderRecorded: 1,
  OrderStatusChanged: 1,
  GrievanceFiled: 1,
  GrievanceResolved: 1,
  AppealFiled: 1,
  AppealDecided: 1,
  VoiceNoteTranscribed: 1,
  WhatsAppOnboardingCompleted: 1,
  AdCampaignSubmitted: 1,
  AdCampaignReviewed: 1,
  AdCampaignStatusChanged: 1,
  AdBudgetExhausted: 1,
  AdIneligible: 1,
  AdWalletToppedUp: 1,
  AdWalletLow: 1,
  AdClicked: 1,
  AdClickInvalidated: 1,
  AdSpendSettled: 1,
  AdImpressionsRolledUp: 1,
  AdAttributionRecorded: 1,
  PromotionPublished: 1,
  PromotionArchived: 1,
  OfferCreated: 1,
  OfferActivated: 1,
  OfferRejected: 1,
  OfferEnded: 1,
  OfferHonourReported: 1,
  OfferHonourDecided: 1,
  CouponRedeemed: 1,
  CouponVoided: 1,
  ReferralQualified: 1,
  ReferralRewarded: 1,
  ReferralRejected: 1,
  PaymentSucceeded: 1,
  PaymentFailed: 1,
  PaymentRefunded: 1,
  KycSubmitted: 1,
  KycDecided: 1,
  AuditCompleted: 1,
  ReachabilityChecked: 1,
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
