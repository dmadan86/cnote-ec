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
  // variants-stock (docs/design/variants-stock.md)
  /** The listing's EFFECTIVE availability (best of its variants, or its own when it has none) changed. Operational data: emitted by the stock fast path and by a publish that carries a different stock state, never by a content edit. Drives the wishlist back-in-stock alert (out_of_stock -> in_stock | made_to_order). `variantId` is the variant that caused the change, null for a listing-level change. */
  ListingAvailabilityChanged: { listingId: string; sellerBusinessId: string; fromAvailability: "in_stock" | "made_to_order" | "out_of_stock"; toAvailability: "in_stock" | "made_to_order" | "out_of_stock"; availableQty: number | null; variantId: string | null };
  ListingImageModerated: { imageId: string; listingId: string; sellerBusinessId: string; status: "approved" | "rejected"; moderatedBy: string };
  // enquiry & matching
  /** v2 adds the RFQ depth fields (all optional, absent on v1 rows): attachment count (files are never in the event), preferred minimum seller tier and the quote expiry. v3 (rfq-multiline) adds `lineCount`, the number of bill-of-materials lines (1..50); absent on v1/v2 rows. */
  EnquiryCreated: { enquiryId: string; buyerBusinessId: string; categoryId: string | null; attachmentCount?: number; minSellerTier?: number | null; expiresAt?: string | null; lineCount?: number };
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
  /** v2 (rfq-multiline) adds per-line quote summary, absent on v1 rows: `lineCount` priced lines and the server-computed `totalPaise` (lines, GST per line). `pricePaise`/`quantity` mirror the first priced line. */
  QuoteSent: { quoteId: string; conversationId: string; sellerBusinessId: string; pricePaise: number; quantity: number; lineCount?: number; totalPaise?: number };
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
  /** One opted-in alert for one buyer, ready to be delivered by @cnote/notifications. `label` is a listing title or saved-search name; `count` the number of listings.
   *  v2 (variants-stock): `alertType` gains "listing_relisted" ("a saved listing is live again", formerly mislabelled back_in_stock); "back_in_stock" now means a real availability transition and carries the new `availability`. v1 rows have neither. */
  BuyerAlertTriggered: { personId: string; alertType: "price_drop" | "back_in_stock" | "listing_relisted" | "followed_digest" | "saved_search"; availability?: "in_stock" | "made_to_order"; subjectId: string | null; label: string; count: number; fromPricePaise: number | null; toPricePaise: number | null; href: string };
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
  /** The buyer awarded requirement lines to one supplier's quote (rfq-multiline): one event per supplier, emitted with the Order that is recorded for it. */
  LinesAwarded: { enquiryId: string; quoteId: string; orderId: string; matchId: string; buyerBusinessId: string; sellerBusinessId: string; enquiryLineIds: string[]; totalPaise: number };
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
  EscrowRefunded:         { escrowId: string; orderId: string; buyerBusinessId: string; amountPaise: number; cause: "cancelled" | "dispute_resolution" | "funding_expired" | "staff" | "return_credit" };
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
  // buyer team roles + approval chains (docs/design/buyer-approvals.md). The invitee's email and decision comments never travel in events.
  BuyerMemberInvited:   { businessId: string; inviteId: string; role: string; invitedByPersonId: string; expiresAt: string };
  BuyerMemberJoined:    { businessId: string; personId: string; role: string; inviteId: string };
  BuyerMemberRoleChanged: { businessId: string; personId: string; from: string; to: string; changedByPersonId: string };
  BuyerMemberRemoved:   { businessId: string; personId: string; removedByPersonId: string };
  BusinessOwnershipTransferred: { businessId: string; fromPersonId: string; toPersonId: string };
  /** A level of the chain became active: `approverPersonIds` are everyone who can decide it now (delegates not included). */
  ApprovalRequested:    { requestId: string; businessId: string; action: string; subjectType: string; subjectId: string; subjectSummary: string; amountPaise: number; requesterPersonId: string; level: number; totalLevels: number; approverPersonIds: string[] };
  ApprovalDecided:      { requestId: string; businessId: string; level: number; decision: "approved" | "rejected"; deciderPersonId: string; onBehalfOfPersonId: string | null };
  /** The whole chain approved. Callers resume the held action from this event (a synchronous requireApproval "approved" emits nothing). */
  ApprovalApproved:     { requestId: string; businessId: string; action: string; subjectType: string; subjectId: string; subjectSummary: string; amountPaise: number; requesterPersonId: string };
  /** Chain ended without approval: a rejection, a withdrawal by the requester or the SLA expiry. */
  ApprovalRejected:     { requestId: string; businessId: string; action: string; subjectType: string; subjectId: string; subjectSummary: string; amountPaise: number; requesterPersonId: string; cause: "rejected" | "cancelled" | "expired"; deciderPersonId: string | null };
  ApprovalReminder:     { requestId: string; businessId: string; subjectSummary: string; level: number; reminderNo: number; approverPersonIds: string[] };
  // purchase orders, supplier invoices and MSME payment dues (docs/design/purchase-orders.md)
  PurchaseOrderIssued: { purchaseOrderId: string; orderId: string; number: string; version: 1; buyerBusinessId: string; sellerBusinessId: string; totalPaise: number; paymentTermsDays: number };
  PurchaseOrderAmended: { purchaseOrderId: string; orderId: string; number: string; version: number; previousVersion: number; buyerBusinessId: string; sellerBusinessId: string; totalPaise: number; paymentTermsDays: number };
  PurchaseOrderAcknowledged: { purchaseOrderId: string; orderId: string; number: string; version: number; buyerBusinessId: string; sellerBusinessId: string; decision: "accepted" | "rejected"; reason: string | null };
  PurchaseOrderCancelled: { purchaseOrderId: string; orderId: string; number: string; buyerBusinessId: string; sellerBusinessId: string; cancelledByBusinessId: string; reason: string | null };
  SupplierInvoiceRecorded: { supplierInvoiceId: string; purchaseOrderId: string; orderId: string; buyerBusinessId: string; sellerBusinessId: string; invoiceNumber: string; totalPaise: number; dueDate: string | null; msmeCovered: boolean; hasIrn: boolean; hasEwayBill: boolean };
  SupplierInvoicePaymentRecorded: { supplierInvoiceId: string; purchaseOrderId: string; orderId: string; buyerBusinessId: string; sellerBusinessId: string; amountPaise: number; paidOn: string; fullyPaid: boolean; msmeCovered: boolean; late: boolean };
  /** Scheduled MSME 43B(h) reminder: stage t7 = due in 7 days or less, t1 = due tomorrow or today, overdue = past due. Sent once per stage. */
  SupplierInvoiceDueReminder: { supplierInvoiceId: string; purchaseOrderId: string; orderId: string; buyerBusinessId: string; sellerBusinessId: string; invoiceNumber: string; stage: "t7" | "t1" | "overdue"; dueDate: string; outstandingPaise: number; daysOverdue: number };
  SupplierInvoiceVoided: { supplierInvoiceId: string; purchaseOrderId: string; orderId: string; buyerBusinessId: string; sellerBusinessId: string; invoiceNumber: string; reason: string; system: boolean };
  BusinessMsmeDeclared: { businessId: string; category: "micro" | "small" | "medium" | null; udyamOnFile: boolean };
  // goods receipt notes, three-way match and returns (docs/design/grn-returns.md)
  /** Buyer recorded a receipt against a PO. `deliveryConfirmed` = this receipt's accepted units confirmed delivery (day of acceptance, s.43B(h)); false when delivery was already confirmed. */
  GoodsReceiptRecorded: { goodsReceiptId: string; number: string; purchaseOrderId: string; orderId: string; buyerBusinessId: string; sellerBusinessId: string; receivedOn: string; acceptedUnits: number; rejectedUnits: number; deliveryConfirmed: boolean };
  /** Buyer paid an invoice whose three-way match was blocking, with a logged reason (the reason text stays in invoice_match_overrides). */
  InvoiceMatchOverridden: { supplierInvoiceId: string; purchaseOrderId: string; orderId: string; buyerBusinessId: string; sellerBusinessId: string; invoiceNumber: string; matchStatus: "mismatch" | "pending_grn" };
  GoodsReturnRequested: { goodsReturnId: string; number: string; goodsReceiptId: string; purchaseOrderId: string; orderId: string; buyerBusinessId: string; sellerBusinessId: string; units: number; estimatedPaise: number; reasonCode: string };
  GoodsReturnDecided: { goodsReturnId: string; number: string; orderId: string; buyerBusinessId: string; sellerBusinessId: string; decision: "approved" | "rejected" };
  GoodsReturnCancelled: { goodsReturnId: string; number: string; orderId: string; buyerBusinessId: string; sellerBusinessId: string };
  GoodsReturnShipped: { goodsReturnId: string; number: string; orderId: string; buyerBusinessId: string; sellerBusinessId: string; hasTrackingRef: boolean };
  GoodsReturnReceived: { goodsReturnId: string; number: string; orderId: string; buyerBusinessId: string; sellerBusinessId: string };
  /** Seller credit note for a return: `totalPaise` reduces the invoice payable; escrow refunds up to that amount from held funds. */
  ReturnCreditNoteRecorded: { creditNoteId: string; goodsReturnId: string; returnNumber: string; supplierInvoiceId: string; orderId: string; buyerBusinessId: string; sellerBusinessId: string; creditNoteNumber: string; totalPaise: number; outstandingPaise: number; refundDuePaise: number; hasIrn: boolean };
  GoodsReturnDisputeLinked: { goodsReturnId: string; number: string; disputeId: string; orderId: string; buyerBusinessId: string; sellerBusinessId: string };
  // rate contracts and call-offs (docs/design/rate-contracts.md); payloads carry ids, numbers and paise, never terms text or addresses
  RateContractProposed: { contractId: string; number: string; buyerBusinessId: string; sellerBusinessId: string; revision: number; proposedByBusinessId: string; amendment: boolean; validFrom: string; validTo: string };
  RateContractActivated: { contractId: string; number: string; buyerBusinessId: string; sellerBusinessId: string; revision: number; amendment: boolean; validFrom: string; validTo: string };
  RateContractRejected: { contractId: string; number: string; buyerBusinessId: string; sellerBusinessId: string; revision: number; rejectedByBusinessId: string; reason: string | null };
  RateContractTerminated: { contractId: string; number: string; buyerBusinessId: string; sellerBusinessId: string; terminatedByBusinessId: string; reason: string | null };
  RateContractExpired: { contractId: string; number: string; buyerBusinessId: string; sellerBusinessId: string; validTo: string };
  RateContractCallOffPlaced: { contractId: string; number: string; buyerBusinessId: string; sellerBusinessId: string; callOffId: string; callOffNo: number; orderId: string; taxablePaise: number; lineCount: number };
  /** A call-off's quantities were given back to the contract because its order was cancelled. */
  RateContractCallOffReleased: { contractId: string; number: string; buyerBusinessId: string; sellerBusinessId: string; callOffId: string; orderId: string };
  /** Consumption crossed 80% or 100% of a quantity cap (scope item) or of the value cap (scope value). Sent once per scope and threshold. */
  RateContractConsumptionWarning: { contractId: string; number: string; buyerBusinessId: string; sellerBusinessId: string; scope: "item" | "value"; itemKey: string | null; itemDescription: string | null; threshold: 80 | 100; usedPercent: number };
  /** Scheduled reminder 30 or 7 days before the active revision ends. The contract never renews by itself. */
  RateContractExpiryReminder: { contractId: string; number: string; buyerBusinessId: string; sellerBusinessId: string; daysLeft: 30 | 7; validTo: string };
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
  ListingAvailabilityChanged: 1,
  EnquiryCreated: 3,
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
  QuoteSent: 2,
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
  BuyerAlertTriggered: 2,
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
  LinesAwarded: 1,
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
  // buyer team roles + approval chains
  BuyerMemberInvited: 1,
  BuyerMemberJoined: 1,
  BuyerMemberRoleChanged: 1,
  BuyerMemberRemoved: 1,
  BusinessOwnershipTransferred: 1,
  ApprovalRequested: 1,
  ApprovalDecided: 1,
  ApprovalApproved: 1,
  ApprovalRejected: 1,
  ApprovalReminder: 1,
  // purchase orders / supplier invoices / MSME dues
  PurchaseOrderIssued: 1,
  PurchaseOrderAmended: 1,
  PurchaseOrderAcknowledged: 1,
  PurchaseOrderCancelled: 1,
  SupplierInvoiceRecorded: 1,
  SupplierInvoicePaymentRecorded: 1,
  SupplierInvoiceDueReminder: 1,
  SupplierInvoiceVoided: 1,
  BusinessMsmeDeclared: 1,
  // goods receipts / three-way match / returns
  GoodsReceiptRecorded: 1,
  InvoiceMatchOverridden: 1,
  GoodsReturnRequested: 1,
  GoodsReturnDecided: 1,
  GoodsReturnCancelled: 1,
  GoodsReturnShipped: 1,
  GoodsReturnReceived: 1,
  ReturnCreditNoteRecorded: 1,
  GoodsReturnDisputeLinked: 1,
  // rate contracts
  RateContractProposed: 1,
  RateContractActivated: 1,
  RateContractRejected: 1,
  RateContractTerminated: 1,
  RateContractExpired: 1,
  RateContractCallOffPlaced: 1,
  RateContractCallOffReleased: 1,
  RateContractConsumptionWarning: 1,
  RateContractExpiryReminder: 1,
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
