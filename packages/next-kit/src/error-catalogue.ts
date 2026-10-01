// Stable error-key catalogue (ADR-004: vernacular UX). DomainError messages are English; apps translate them by key.
//
// Convention (see docs/guides/i18n.md): new errors should pass an explicit key as the 4th constructor argument,
// `new DomainError("conflict", "Not enough lead credits.", undefined, "credits.insufficient")`, and add
// `errors.credits.insufficient` to the `errors` namespace of the seller and web catalogues (all 8 locales).
// Errors thrown before that convention existed are mapped here from their exact English message, so no domain
// package needed editing. `error` stays the English fallback for any message without a translation.
import type { DomainError } from "@cnote/core";

/** Key used for the generic "fix the highlighted fields" message when validation produced per-field errors. */
export const FIELD_ERRORS_KEY = "common.fixFields";

/** Exact English DomainError message -> message key under `errors.*`. A test checks each message still exists in the source. */
export const ERROR_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  "Please fix the highlighted fields.": "common.fixFields",
  "Not signed in.": "auth.notSignedIn",
  "Your sign-in expired. Please sign in again.": "auth.signInExpired",
  "Please sign in again.": "auth.pleaseSignIn",
  "Session expired. Please sign in again.": "auth.sessionExpired",
  "Invalid email or password": "auth.invalidCredentials",
  "An account with this email already exists. Try signing in.": "auth.emailExists",
  "This reset link is invalid or has expired.": "auth.resetInvalid",
  "That code is incorrect or has expired.": "auth.codeIncorrectExpired",
  "That code is incorrect or has already been used.": "auth.codeIncorrectUsed",
  "Too many incorrect attempts. Request a new code.": "auth.tooManyAttempts",
  "This account is no longer available.": "auth.accountUnavailable",
  "This account has been deleted.": "auth.accountDeleted",
  "Google sign-in failed. Please try again.": "auth.googleFailed",
  "Your Google account email is not verified.": "auth.googleUnverified",
  "Two-factor authentication is already enabled.": "auth.mfaAlreadyOn",
  "We couldn't verify that you're human. Please retry the check and submit again.": "auth.humanCheck",
  "Enter a valid phone number with country code.": "auth.phoneInvalid",
  "This phone number is already linked to another account.": "auth.phoneTaken",
  "Verify your mobile number first.": "auth.verifyPhoneFirst",
  "Only the business owner (authorised signatory) can complete KYC.": "kyc.ownerOnly",
  "KYC session not found.": "kyc.sessionNotFound",
  "Verify your GSTIN first (Tier 1) before starting KYC.": "kyc.gstinFirst",
  "This business is already KYC verified.": "kyc.alreadyVerified",
  "This KYC session has expired. Start again.": "kyc.expired",
  "This KYC session is no longer accepting documents.": "kyc.notAccepting",
  "Add a GSTIN first.": "gst.addFirst",
  "This GSTIN is already registered to another business.": "gst.taken",
  "PAN must match characters 3–12 of the GSTIN.": "gst.panMismatch",
  "Only a business owner can change company details.": "company.ownerOnly",
  "Not your listing": "listings.notYours",
  "Archived listings cannot be edited": "listings.archivedEdit",
  "Archived listings cannot be submitted": "listings.archivedSubmit",
  "Nothing has changed since the live version": "listings.noChanges",
  "Image not found": "listings.imageNotFound",
  "Too many uploads. Please try again in a while.": "listings.tooManyUploads",
  "Too many voice notes. Please try again in a while.": "listings.tooManyVoice",
  "We could not hear anything in that recording. Please try again, closer to the microphone.": "listings.voiceSilent",
  "Too many photo drafts. Please try again in a while.": "listings.tooManyDrafts",
  "Describe your product in 3-5000 characters": "listings.describeLength",
  "This category is not allowed on the marketplace.": "listings.categoryProhibited",
  "Conversation not found": "conversations.notFound",
  "This conversation is closed.": "conversations.closed",
  "You are sending messages too fast. Wait a moment.": "conversations.tooFast",
  "Only the seller can send a quote.": "quotes.sellerOnly",
  "The 2-hour response window for this lead has passed.": "leads.windowPassed",
  "This requirement is no longer open.": "leads.requirementClosed",
  "This lead can no longer be declined.": "leads.cannotDecline",
  "The 72-hour refund window for this lead has passed.": "leads.refundWindowPassed",
  "The buyer confirmed they still need this. Please contact them again.": "leads.buyerStillNeeds",
  "Only accepted leads can be reported.": "leads.onlyAcceptedReport",
  "Lead not found": "leads.notFound",
  "Requirement not found": "leads.requirementNotFound",
  "You have posted many requirements this hour. Please try again a little later.": "leads.postLimit",
  "Pick at least one seller.": "leads.pickOne",
  "This requirement is not open for picking.": "leads.notOpenForPicking",
  "Not enough lead credits. Top up on the pricing page to accept this lead.": "credits.insufficient",
  "Accept the lead before drafting a quote.": "quotes.acceptFirst",
  "Quote assist is not enabled.": "quotes.assistDisabled",
  "Too many draft requests. Try again later.": "quotes.tooManyDrafts",
  "Draft not found": "quotes.draftNotFound",
  "This draft was already handled.": "quotes.draftHandled",
  "This draft was already sent.": "quotes.draftSent",
  "Quote not found": "quotes.notFound",
  "Set a target price, a maximum price or a delivery limit first.": "quotes.setLimits",
  "No counter fits your limits for this quote. Adjust your maximum price or negotiate by message.": "quotes.noCounterFits",
  "Order not found": "orders.notFound",
  "Only accepted leads can become orders.": "orders.onlyAccepted",
  "An order needs at least one item.": "orders.needItem",
  "Quantity must be a whole number above 0.": "orders.quantity",
  "Only INR orders are supported.": "orders.inrOnly",
  "You are already on this plan.": "billing.samePlan",
  "Paid plans start from checkout.": "billing.paidFromCheckout",
  "You have no paid plan to cancel.": "billing.noPlanToCancel",
  "Plan not found": "billing.planNotFound",
  "Credit pack not found": "billing.packNotFound",
  "Add a phone number to your account to pay.": "billing.addPhone",
  "The free plan needs no payment.": "billing.freePlan",
  "Coupons are not available right now.": "billing.couponsUnavailable",
  "Nothing to pay after the discount.": "billing.nothingToPay",
  "Payment order not found": "billing.paymentOrderNotFound",
  "Payment not found": "billing.paymentNotFound",
  "Invoice not found": "billing.invoiceNotFound",
  "Not enough ad wallet balance": "billing.adWalletLow",
  "Refund exceeds the amount paid": "billing.refundExceeds",
  "Only paid orders can be refunded": "billing.onlyPaidRefund",
  "You can't review your own product.": "reviews.ownProduct",
  "You've already reviewed this product. Refresh to edit your review.": "reviews.alreadyReviewed",
  "Only the seller can reply to this review.": "reviews.sellerReplyOnly",
  "Only the seller can reply to a question.": "reviews.sellerAnswerOnly",
  "That question no longer exists.": "reviews.questionGone",
  "Too many actions. Please slow down.": "reviews.tooManyActions",
  "This product is not available.": "reviews.productUnavailable",
  "Dispute not found": "disputes.notFound",
  "There is already an open dispute for this order.": "disputes.alreadyOpen",
  "Describe the problem in at least 10 characters (or attach a voice note).": "disputes.describe",
  "The amount you claim cannot exceed the value of the order.": "disputes.claimTooHigh",
  "Evidence can no longer be added: the case is already being reviewed.": "disputes.evidenceClosed",
  "You have reached the evidence limit for this case.": "disputes.evidenceLimit",
  "Each file must be 8 MB or smaller.": "disputes.fileTooBig",
  "The file is empty.": "disputes.fileEmpty",
  "Write a message of up to 2000 characters.": "disputes.messageLength",
  "Only the other party can respond to a dispute you opened.": "disputes.otherPartyRespond",
  "Only the party that opened the dispute can withdraw it.": "disputes.openerWithdraw",
  "Please consent to us storing and transcribing your voice note (DPDP).": "disputes.voiceConsent",
  "Only a decided dispute can be appealed.": "disputes.appealDecidedOnly",
  "You have already appealed this decision.": "disputes.alreadyAppealed",
  "Explain why you are appealing (10 to 2000 characters).": "disputes.appealReason",
  "Escrow not found": "escrow.notFound",
  "Escrow is frozen while a dispute is open.": "escrow.frozenDispute",
  "Only a funded escrow can be released.": "escrow.releaseFunded",
  "The seller has not dispatched this order yet.": "escrow.notDispatched",
  "No funds are held for this escrow.": "escrow.noFunds",
  "Amount exceeds the funds held in escrow.": "escrow.amountExceeds",
  "Escrow is not available yet.": "escrow.unavailable",
  "Consent to credit underwriting is required before you can apply.": "lending.consentApply",
  "Consent to credit underwriting is required.": "lending.consent",
  "Choose one of the offered repayment periods.": "lending.choosePeriod",
  "There is already an active credit application for this order.": "lending.activeApplication",
  "Our lending partner is unavailable right now. Please try again later.": "lending.partnerDown",
  "Offer not found.": "lending.offerNotFound",
  "Please confirm that you have read the Key Fact Statement.": "lending.confirmKfs",
  "The terms have changed. Please review the Key Fact Statement again.": "lending.termsChanged",
  "This offer is no longer open.": "lending.offerClosed",
  "This offer has expired.": "lending.offerExpired",
  "Credit is not available yet.": "lending.unavailable",
  "You're saving items too quickly. Please wait a minute and try again.": "wishlist.tooFast",
  "You already have a list with that name": "wishlist.nameTaken",
  "This escrow is frozen while a dispute is open.": "escrow.frozenDispute",
};

/** The stable key of an error: its explicit `key`, else the key registered for its exact English message. */
export function errorKeyFor(err: Pick<DomainError, "message" | "key">): string | undefined {
  // Own keys only: a message like "__proto__" or "constructor" must not resolve to an inherited Object.prototype member.
  return err.key ?? (Object.hasOwn(ERROR_MESSAGE_KEYS, err.message) ? ERROR_MESSAGE_KEYS[err.message] : undefined);
}

/** Result shape both `ActionResult` and API error bodies satisfy. */
export interface KeyedError {
  error: string;
  errorKey?: string;
  errorParams?: Record<string, string | number>;
}

/**
 * Localised text for a failed result: `translate(key)` returns the translation or `undefined` when the catalogue has
 * none (then the English `error` is shown). `translate` is typically `(k) => (t.has(k) ? t(k) : undefined)`.
 */
export function localizeError(result: KeyedError, translate: (key: string, params?: Record<string, string | number>) => string | undefined): string {
  if (!result.errorKey) return result.error;
  try {
    return translate(result.errorKey, result.errorParams) ?? result.error;
  } catch {
    return result.error;
  }
}
