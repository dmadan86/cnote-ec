// Versioned domain event catalogue (ADR-007). This is the cross-module contract: modules emit and
// consume only these shapes. Changing a payload = add a new version; never mutate an old one.
// Money in payloads is integer paise as `number` (JSON has no bigint).

export interface DomainEventPayloads {
  // identity
  PersonRegistered: { personId: string; phone: string };
  BusinessCreated: { businessId: string; personId: string; isSeller: boolean };
  BusinessVerified: { businessId: string; tier: number; kind: string };
  /** A business's claim on a GSTIN was released (superseded by a verified, name-matching claimant, or by staff after a dispute). ADR-003. */
  GstinClaimReleased: { businessId: string; gstin: string; reason: "superseded" | "staff_dispute"; byBusinessId?: string; staffId?: string };
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
  /** The published price (or unit) of a live listing changed (emitted with the publish, in the same transaction). Null = "price on request". Drives wishlist price-drop alerts. */
  ListingPriceChanged: { listingId: string; sellerBusinessId: string; fromPricePaise: number | null; toPricePaise: number | null; fromPriceUnit: string | null; priceUnit: string | null };
  ListingImageProcessed: { imageId: string; listingId: string; variants: number };
  ListingImageModerated: { imageId: string; listingId: string; sellerBusinessId: string; status: "approved" | "rejected"; moderatedBy: string };
  // enquiry & matching
  /** v2 adds the RFQ depth fields (all optional, absent on v1 rows): attachment count (files are never in the event), preferred minimum seller tier and the quote expiry. */
  EnquiryCreated: { enquiryId: string; buyerBusinessId: string; categoryId: string | null; attachmentCount?: number; minSellerTier?: number | null; expiresAt?: string | null };
  EnquiryScored: { enquiryId: string; intentScore: number; needsReview: boolean };
  LeadMatched: { enquiryId: string; matchId: string; sellerBusinessId: string; rank: number; matchScore: number };
  LeadAccepted: { enquiryId: string; matchId: string; sellerBusinessId: string; creditTxnId: string | null; responseMs: number };
  LeadDeclined: { enquiryId: string; matchId: string; sellerBusinessId: string; reason?: string };
  LeadExpired: { enquiryId: string; matchId: string; sellerBusinessId: string };
  LeadRefunded: { enquiryId: string; matchId: string; sellerBusinessId: string; reason: "buyer_unreachable" | "buyer_fake" | "enquiry_rejected" };
  /** a seller's buyer_fake refund request tripped the per-seller refund guard: held for staff (security audit M2) */
  LeadRefundHeld: { enquiryId: string; matchId: string; sellerBusinessId: string; kind: "buyer_fake"; reason: string; refundRateBps: number };
  LeadRefundReviewed: { enquiryId: string; matchId: string; sellerBusinessId: string; decision: "approved" | "rejected"; decidedBy: string };
  ConversationStarted: { conversationId: string; matchId: string };
  MessageSent: { conversationId: string; messageId: string; senderPersonId: string };
  QuoteSent: { quoteId: string; conversationId: string; sellerBusinessId: string; pricePaise: number; quantity: number };
  DealReportedOffPlatform: { matchId: string; reportedByBusinessId: string; outcome: "won" | "lost" | "pending"; valuePaise?: number };
  /** the seller reports the deal as won: advisory only, the buyer is asked to confirm (security audit M7) */
  DealClaimedBySeller: { matchId: string; sellerBusinessId: string; buyerBusinessId: string; conversationId: string | null; valuePaise?: number };
  // reviews (user-generated content; public only after staff approval)
  ReviewSubmitted: { reviewId: string; listingId: string; sellerBusinessId: string; authorPersonId: string; rating: number; aiVerdict: string | null };
  ReviewModerated: { reviewId: string; listingId: string; sellerBusinessId: string; status: "approved" | "rejected"; rating: number; moderatedBy: string };
  CommentSubmitted: { commentId: string; listingId: string; parentId: string | null; authorPersonId: string; isSeller: boolean; aiVerdict: string | null };
  CommentModerated: { commentId: string; listingId: string; status: "approved" | "rejected"; moderatedBy: string };
  // product questions & answers (buyer asks, seller answers; public only once answered and approved)
  ProductQuestionAsked: { questionId: string; listingId: string; sellerBusinessId: string; askerPersonId: string; status: "pending" | "flagged" | "approved"; aiVerdict: string | null; piiStripped: boolean };
  ProductQuestionAnswered: { questionId: string; answerId: string; listingId: string; sellerBusinessId: string; askerPersonId: string; answeredByPersonId: string; status: "pending" | "flagged" | "approved"; aiVerdict: string | null; piiStripped: boolean };
  /** Staff decision on a held (or reported) question/answer. `askerPersonId` lets observers notify without a lookup. */
  ProductQaModerated: { kind: "question" | "answer"; id: string; questionId: string; listingId: string; sellerBusinessId: string; askerPersonId: string; status: "approved" | "rejected"; moderatedBy: string };
  // wishlist (demand signal for sellers/search; no PII beyond ids)
  WishlistItemAdded: { wishlistId: string; personId: string; listingId: string };
  WishlistItemRemoved: { wishlistId: string; personId: string; listingId: string };
  // buyer retention (docs/design/buyer-retention.md): following a supplier never affects ranking
  SupplierFollowChanged: { personId: string; businessId: string; following: boolean };
  /** One opted-in alert for one buyer, ready to be delivered by @cnote/notifications. `label` is a listing title or saved-search name; `count` the number of listings. */
  BuyerAlertTriggered: { personId: string; alertType: "price_drop" | "back_in_stock" | "followed_digest" | "saved_search"; subjectId: string | null; label: string; count: number; fromPricePaise: number | null; toPricePaise: number | null; href: string };
  // storefronts (seller mini-sites)
  StorefrontPublished: { storefrontId: string; sellerBusinessId: string; slug: string; versionId: string };
  StorefrontVersionReviewed: { storefrontId: string; sellerBusinessId: string; versionId: string; status: "published" | "rejected"; reviewedBy: string };
  StorefrontSuspended: { storefrontId: string; sellerBusinessId: string; reason: string };
  StorefrontDomainStatusChanged: { domainId: string; storefrontId: string; sellerBusinessId: string; hostname: string; from: string; to: string; error: string | null };
  /** An unverified claim on a hostname was dropped: another claimant proved DNS control first, or the claim expired (anti-squatting). */
  DomainClaimSuperseded: { domainId: string; storefrontId: string; sellerBusinessId: string; hostname: string; reason: "other_party_verified" | "expired" };
  // bulk import / export
  BulkJobFinished: { jobId: string; sellerBusinessId: string; createdBy: string; kind: "import" | "export"; status: string; created: number; updated: number; errors: number };
  // lead generation (buyer unlock funnel)
  LeadCaptureVerified: { captureId: string; personId: string; trigger: string; unlock: string; listingId: string | null; isNewPerson: boolean };
  LeadCaptureConverted: { captureId: string; personId: string; trigger: string; enquiryId: string | null };
  // buyer used a supplier contact channel after a legitimate unlock (accepted match); never carries the number or address itself
  SupplierContacted: { buyerPersonId: string; sellerBusinessId: string; listingId: string; enquiryId: string; channel: "call" | "whatsapp" | "email" | "enquiry" };
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
  /** a paid order whose coupon could no longer be redeemed at fulfilment: bonus credits stripped, staff to review (security audit M3) */
  CouponRedemptionDiscrepancy: { paymentOrderId: string; businessId: string; couponId: string; discountPaise: number; bonusStripped: number; reason: string };
  PaymentRefunded: { paymentOrderId: string; businessId: string; amountPaise: number; creditNoteNumber: string | null };
  /** The provider confirmed the money is back with the payer (immediately, via webhook or a retry). */
  RefundCompleted: { refundId: string; paymentOrderId: string; businessId: string; amountPaise: number };
  /** A refund exhausted its automatic retries: ops must act (alert + metric). */
  RefundDeadLettered: { refundId: string; paymentOrderId: string; businessId: string; amountPaise: number; attempts: number; lastError: string | null };
  // escrow via PA partner (ADR-012, Phase 2, flag ESCROW_ENABLED)
  EscrowCreated:          { escrowId: string; orderId: string; buyerBusinessId: string; sellerBusinessId: string; amountPaise: number; feePaise: number; partner: string };
  /** v2 adds matchId (null for network orders) so the ADR-012 gate "accepted leads -> escrowed orders" is measurable */
  EscrowFunded:           { escrowId: string; orderId: string; amountPaise: number; partnerRef: string; matchId: string | null };
  EscrowMilestoneReached: { escrowId: string; orderId: string; milestone: "confirmed" | "dispatched" | "delivered" | "accepted" };
  EscrowFrozen:           { escrowId: string; orderId: string; disputeId: string };
  EscrowUnfrozen:         { escrowId: string; orderId: string; disputeId: string };
  EscrowReleased:         { escrowId: string; orderId: string; sellerBusinessId: string; amountPaise: number; feePaise: number; cause: "buyer_accepted" | "auto_release" | "dispute_resolution" | "staff" };
  EscrowRefunded:         { escrowId: string; orderId: string; buyerBusinessId: string; amountPaise: number; cause: "cancelled" | "dispute_resolution" | "funding_expired" | "staff" };
  PayoutSettled:          { payoutId: string; escrowId: string; sellerBusinessId: string; amountPaise: number; partnerRef: string; latencyMs: number };
  /** seller proceeds assigned to an NBFC were paid to the lender first (ADR-019 invoice financing) */
  EscrowLenderRepaid:     { payoutId: string; escrowId: string; assignmentId: string; amountPaise: number; partnerRef: string };
  // disputes (ADR-013)
  DisputeOpened:    { disputeId: string; orderId: string; openedByBusinessId: string; againstBusinessId: string; type: string; amountPaise: number | null };
  DisputeBriefReady: { disputeId: string; orderId: string; recommendation: string; confidence: number; autoResolvable: boolean };
  DisputeEscalated: { disputeId: string; orderId: string; byBusinessId: string };
  DisputeResolved:  { disputeId: string; orderId: string; outcome: "buyer_favour" | "seller_favour" | "split" | "withdrawn"; refundPaise: number; releasePaise: number; decidedBy: "auto" | "staff"; faultBusinessId: string | null };
  // quote assist (ADR-014)
  QuoteDraftGenerated:  { draftId: string; matchId: string; sellerBusinessId: string; pricePaise: number | null; confidence: number };
  QuoteDraftApproved:   { draftId: string; matchId: string; quoteId: string; sellerBusinessId: string; edited: boolean };
  CounterOfferProposed: { proposalId: string; enquiryId: string; quoteId: string; buyerBusinessId: string; pricePaise: number };
  // CV quality checks (ADR-015)
  QualityCheckCompleted: { checkId: string; orderId: string; sellerBusinessId: string; categorySlug: string; verdict: "consistent" | "inconsistent" | "inconclusive"; confidence: number };
  // vertical playbooks (ADR-016)
  VerticalStageChanged: { verticalId: string; slug: string; from: string; to: string; changedBy: string };
  // ONDC adapter (ADR-017)
  OndcCatalogPublished: { sellerBusinessId: string; providerId: string; items: number };
  OndcOrderReceived:    { ondcOrderId: string; orderId: string | null; sellerBusinessId: string; bapId: string; transactionId: string };
  // embedded credit via NBFC partner (ADR-019, Phase 3, flag CREDIT_ENABLED)
  CreditScoreComputed:        { businessId: string; score: number; band: string; modelVersion: string };
  CreditApplicationSubmitted: { applicationId: string; businessId: string; product: "invoice_financing" | "bnpl"; amountPaise: number; partner: string; orderId: string | null };
  CreditOfferReceived:        { applicationId: string; offerId: string; amountPaise: number; aprBps: number; tenorDays: number };
  CreditDisbursed:            { loanId: string; applicationId: string; businessId: string; amountPaise: number; orderId: string | null };
  CreditRepaid:               { loanId: string; amountPaise: number; outstandingPaise: number };
  CreditOverdue:              { loanId: string; businessId: string; dpd: number };
  CreditClosed:               { loanId: string; businessId: string; status: "repaid" | "written_off" };
  // agent-to-agent commerce (ADR-020)
  AgentMandateCreated:      { mandateId: string; businessId: string; side: "buyer" | "seller"; autoAccept: boolean };
  AgentNegotiationStarted:  { negotiationId: string; buyerBusinessId: string; sellerBusinessId: string; enquiryId: string | null; external: boolean };
  AgentOfferMade:           { negotiationId: string; round: number; by: "buyer" | "seller"; pricePaise: number; quantity: number };
  /** staff suspended a mandate (or all agent activity of a business) for abuse; the reason stays in the admin audit trail */
  AgentMandateSuspended:    { businessId: string; mandateId: string | null; side: "buyer" | "seller" | null; scope: "mandate" | "business" };
  AgentNegotiationClosed:   { negotiationId: string; outcome: "accepted" | "rejected" | "expired" | "withdrawn"; confirmedBy: "human" | "auto" | null; pricePaise: number | null };
  // price intelligence (ADR-022)
  PriceBenchmarkPublished:  { period: string; categories: number; cells: number; suppressedCells: number };
  // ONDC live (ADR-021): IGM issues mapped onto disputes
  OndcIssueReceived:        { issueId: string; ondcOrderId: string; disputeId: string | null };
  // wave 8: fulfilment sub-stages (ONDC status push, buyer tracking) and credit cooling-off exits
  OrderFulfilmentUpdated: { orderId: string; buyerBusinessId: string; sellerBusinessId: string; stage: "packed" | "in_transit" | "out_for_delivery" | "delivery_attempted"; note: string | null };
  CreditCancelled:        { loanId: string; applicationId: string; businessId: string; reason: "cooling_off" | "partner" };
  // T2/T3 verification (ADR-003)
  KycSubmitted: { sessionId: string; businessId: string; provider: string };
  KycDecided: { sessionId: string; businessId: string; status: "approved" | "rejected" | "review"; decidedBy: string | null };
  AuditCompleted: { auditId: string; businessId: string; result: "pass" | "fail" | "conditional"; validUntil: string | null };
  // trust_verif: T3 partner submitted checklist + photos for staff review (ADR-003)
  AuditSubmitted: { auditId: string; businessId: string; partner: string; photoCount: number; flagged: boolean };
  // buyer reachability (ADR-002)
  // trust_verif: an ops label on an enquiry (fake-lead precision/recall, ADR-002)
  EnquiryLabelled: { enquiryId: string; label: string; isFake: boolean; predictedFake: boolean; riskScore: number; intentScore: number | null };
  ReachabilityChecked: { checkId: string; enquiryId: string; matchId: string | null; channel: string; status: "responded" | "no_response" | "failed"; sellerBusinessId?: string };
  // billing
  CreditsGranted: { businessId: string; amount: number; reason: string; expiresAt: string };
  CreditConsumed: { businessId: string; txnId: string; refType: string; refId: string };
  CreditRefunded: { businessId: string; txnId: string; refType: string; refId: string };
  SubscriptionStarted: { businessId: string; subscriptionId: string; planCode: string };
  /** v2 (ADR-005): adds the interval, the pro-rated refund requested through the payment provider (paise, GST-inclusive) and the optional reason. v1 had only the first three fields. */
  SubscriptionCancelled: { businessId: string; subscriptionId: string; planCode: string; billingInterval: "monthly" | "annual"; refundPaise: number; unusedMonths: number; effectiveAt: string; reason: string | null };
  /** The paid period ends soon and will NOT renew by itself: asks the owner to confirm a renewal (ADR-005). */
  // polish: DPDP (compliance)
  /** 48-hour (or longer) notice that a personal account will be erased for inactivity (DPDP Rules 2025 r.8 / Third Schedule). */
  InactivityErasureNoticeSent: { personId: string; noticeId: string; eraseAfter: string; lastActiveAt: string };
  /** A data principal added, changed or revoked a nominee (DPDP s.14). Never carries the nominee's details. */
  DataNomineeChanged: { personId: string; nomineeId: string; change: "added" | "changed" | "revoked" };
  // polish: developer API keys
  /** An active personal API key is about to expire (threshold "7d" = within 7 days, "expiry_day" = within 24h). Never carries the secret. */
  ApiKeyExpiring: { keyId: string; personId: string; name: string; prefix: string; expiresAt: string; threshold: "7d" | "expiry_day" };
  SubscriptionRenewalDue: { businessId: string; subscriptionId: string; planCode: string; billingInterval: "monthly" | "annual"; periodEnd: string };
  // passkeys (ADR-029/042, docs/design/admin-passkeys.md)
  PasskeyRegistered: { personId: string; realm: string; passkeyId: string; aaguid: string; deviceType: string };
  PasskeyRevoked: { personId: string; realm: string; passkeyId: string; reason: "user" | "reset" | "clone_suspected"; byStaffId?: string };
  /** The authenticator's sign counter did not advance: the credential may have been cloned. It has been revoked. */
  PasskeyCloneSuspected: { personId: string; realm: string; passkeyId: string; storedCount: number; receivedCount: number };
  // ai_ops: attachment malware scanning
  /** The malware scanner flagged an RFQ or quote attachment: bytes quarantined, never visible to the other party; the uploader is told. No file name or content in the payload. */
  AttachmentQuarantined: { quarantineId: string; enquiryId: string; kind: "rfq" | "quote"; uploadedByBusinessId: string; uploadedByPersonId: string; signature: string; scanner: string };
  // ai_ops: storefront embed moderation
  /** A third-party video embed (YouTube / Vimeo) in a storefront was approved, rejected or put back to pending. `decidedBy`: auto (trusted-seller rules), staff, or recheck (periodic re-check of an approved embed). */
  StorefrontEmbedDecided: { storefrontId: string; sellerBusinessId: string; provider: "youtube" | "vimeo"; mediaId: string; status: "approved" | "rejected" | "pending"; decidedBy: "auto" | "staff" | "recheck" };
}

export type DomainEventType = keyof DomainEventPayloads;

/** Current schema version per event type. Bump when a payload shape changes. */
export const EVENT_VERSIONS: { [K in DomainEventType]: number } = {
  PersonRegistered: 1,
  BusinessCreated: 1,
  BusinessVerified: 1,
  GstinClaimReleased: 1,
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
  ListingPriceChanged: 1,
  EnquiryCreated: 2,
  EnquiryScored: 1,
  LeadMatched: 1,
  LeadAccepted: 1,
  LeadDeclined: 1,
  LeadExpired: 1,
  LeadRefunded: 1,
  LeadRefundHeld: 1,
  LeadRefundReviewed: 1,
  ConversationStarted: 1,
  MessageSent: 1,
  QuoteSent: 1,
  DealReportedOffPlatform: 1,
  DealClaimedBySeller: 1,
  ReviewSubmitted: 1,
  ReviewModerated: 1,
  CommentSubmitted: 1,
  CommentModerated: 1,
  ProductQuestionAsked: 1,
  ProductQuestionAnswered: 1,
  ProductQaModerated: 1,
  WishlistItemAdded: 1,
  WishlistItemRemoved: 1,
  SupplierFollowChanged: 1,
  BuyerAlertTriggered: 1,
  StorefrontPublished: 1,
  StorefrontVersionReviewed: 1,
  StorefrontSuspended: 1,
  StorefrontDomainStatusChanged: 1,
  DomainClaimSuperseded: 1,
  BulkJobFinished: 1,
  LeadCaptureVerified: 1,
  LeadCaptureConverted: 1,
  SupplierContacted: 1,
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
  CouponRedemptionDiscrepancy: 1,
  PaymentRefunded: 1,
  RefundCompleted: 1,
  RefundDeadLettered: 1,
  KycSubmitted: 1,
  KycDecided: 1,
  AuditCompleted: 1,
  AuditSubmitted: 1,
  OrderFulfilmentUpdated: 1,
  CreditCancelled: 1,
  CreditScoreComputed: 1,
  CreditApplicationSubmitted: 1,
  CreditOfferReceived: 1,
  CreditDisbursed: 1,
  CreditRepaid: 1,
  CreditOverdue: 1,
  CreditClosed: 1,
  AgentMandateCreated: 1,
  AgentNegotiationStarted: 1,
  AgentOfferMade: 1,
  AgentNegotiationClosed: 1,
  AgentMandateSuspended: 1,
  PriceBenchmarkPublished: 1,
  OndcIssueReceived: 1,
  EscrowCreated: 1,
  EscrowFunded: 2,
  EscrowMilestoneReached: 1,
  EscrowFrozen: 1,
  EscrowUnfrozen: 1,
  EscrowReleased: 1,
  EscrowRefunded: 1,
  PayoutSettled: 1,
  EscrowLenderRepaid: 1,
  DisputeOpened: 1,
  DisputeBriefReady: 1,
  DisputeEscalated: 1,
  DisputeResolved: 1,
  QuoteDraftGenerated: 1,
  QuoteDraftApproved: 1,
  CounterOfferProposed: 1,
  QualityCheckCompleted: 1,
  VerticalStageChanged: 1,
  OndcCatalogPublished: 1,
  OndcOrderReceived: 1,
  ReachabilityChecked: 1,
  EnquiryLabelled: 1,
  CreditsGranted: 1,
  CreditConsumed: 1,
  CreditRefunded: 1,
  SubscriptionStarted: 1,
  SubscriptionCancelled: 2,
  SubscriptionRenewalDue: 1,
  PasskeyRegistered: 1,
  PasskeyRevoked: 1,
  PasskeyCloneSuspected: 1,
  // polish: DPDP (compliance)
  InactivityErasureNoticeSent: 1,
  DataNomineeChanged: 1,
  // polish: developer API keys
  ApiKeyExpiring: 1,
  // ai_ops
  AttachmentQuarantined: 1,
  StorefrontEmbedDecided: 1,
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
