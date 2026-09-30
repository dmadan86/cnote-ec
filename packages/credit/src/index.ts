// @cnote/credit: ADR-019 embedded credit via NBFC partner: platform credit score, invoice financing + BNPL on escrowed orders, partner port. Flag CREDIT_ENABLED.
// PUBLIC CONTRACT. No lending on our own balance sheet: the partner is the lender of record. See docs/design/credit.md.
import "./adapters";

export { worker } from "./worker";
export { creditEnabled, creditConfig, assertCreditEnabled, type CreditConfig } from "./config";
export {
  CREDIT_MODEL_VERSION, SCORE_MIN, SCORE_MAX, BAND_LIMITS, COMPONENT_MAX, EMPTY_FEATURES, bandFor, computeScore, components, reasonsOf,
  type Band, type CreditFeatures, type Reason, type ReasonCode, type ScoreResult,
} from "./model";
export { computeAndStoreScore, gatherFeatures, getLatestScore, listScoreHistory, recomputeAllScores } from "./score";
export { grantCreditConsent, withdrawCreditConsent, hasActiveCreditConsent, actorHasCreditConsent } from "./consent";
export { assessEligibility, maxAmount, TENORS, DEFAULT_TENOR_DAYS, type Eligibility, type EligibilityInput, type IneligibleReason } from "./eligibility";
export { allInAprBps, buildKfs, coolingOffAmount, interestPaise, totalRepayablePaise, type CoolingOffAmount, type CoolingOffTerms, type OfferTerms } from "./kfs";
export {
  acceptOffer, applyForFinancing, buildPartnerRequest, declineOffer, getApplication, getBnplOption, getCreditOverview, listApplications, listLoans, minimalFeatures,
  type AcceptInput, type ApplyInput, type BnplOption, type CreditOverview, type EligibleOrder,
} from "./applications";
export { cancelLoanInCoolingOff, coolingOffQuotesFor, getCoolingOffQuote, type CancelInput, type CoolingOffBlock, type CoolingOffQuote } from "./cooling";
export { handleCreditWebhook, simulateMockDisbursal, type WebhookResult } from "./webhook";
export {
  DPD_BUCKETS, bucketOf, dpdOf, expireOffers, getPayoutAssignmentForEscrow, recordAssignmentSettlement, recordCancellation, retryBnplFunding, syncEscrowAssignment, updateDpd, type PayoutAssignment,
} from "./loans";
export {
  NPA_DPD, attachedShare, computeGnpa, creditAttachedGmvShare, creditStats, fldgExposure, fldgFor, listApplicationsForStaff, listLoansForStaff, overallGnpa, partnerGnpa,
  type AttachedShare, type BookLoan, type CreditStats, type FldgExposure, type PartnerGnpa, type StaffApplicationView,
} from "./stats";
export { purgeClosedCreditData, type CreditPurgeResult } from "./retention";
export { setCreditPorts, ports as creditPorts, type CreditPorts, type DisputeRecord, type EscrowHistory, type GstSignal, type TrustSignal } from "./ports";
export {
  MockPartner, MOCK_LENDER, NbfcPartnerStub, configuredPartnerName, getCreditPartner, isPartnerName, mockPricing, setCreditPartner, SIGNATURE_HEADER,
  type CreditPartner, type PartnerApplicationRequest, type PartnerCancelResult, type PartnerEvent, type PartnerName, type PartnerOffer,
} from "./partner";
export type {
  Actor, ApplicationStatus, ApplicationView, EscrowFacts, Kfs, LenderInfo, LoanStatus, LoanView, OfferView, Product, ScoreView,
} from "./types";
export { PRODUCTS, ACTIVE_APPLICATION_STATUSES } from "./types";
export { getCreditApplicationBusiness } from "./parties";
