// @cnote/escrow: ADR-012 escrow via RBI-authorised PA partner: milestones, double-entry immutable ledger, payouts, reconciliation. Flag ESCROW_ENABLED.
// PUBLIC CONTRACT.
export { worker } from "./worker";
export { escrowEnabled, autoReleaseDays, feeBps, feeCapPaise, fundingTtlHours, minAmountPaise } from "./config";
export { computeFee, feeBreakdown, type FeeBreakdown } from "./fee";
export {
  ACCOUNTS, accountBalance, accountSpec, balancesOf, listJournals, postJournal, trialBalance, validateLines,
  type JournalLineInput, type JournalView, type PostJournalInput, type PostedJournal, type TrialBalance,
} from "./ledger";
export {
  TERMINAL_STATUSES, canTransition, isTerminal, milestoneForOrderStatus,
  type EscrowStatus, type Milestone, type RefundCause, type ReleaseCause,
} from "./state";
export {
  acceptDelivery, createEscrowForOrder, getEscrowDetail, getEscrowForOrder, getEscrowSnapshotForOrder, fundEscrowFromLender, setEscrowLenderAssignment, getEscrowOffer, listEscrows, quoteEscrow, shouldNudgeEscrow,
  staffRefundEscrow, staffReleaseEscrow, runAutoRelease, expireUnfunded,
  type EscrowDetail, type EscrowOffer, type EscrowRow, type EscrowView, type FeeQuote,
} from "./escrow";
export {
  escrowHistoryForBusiness, listEscrowsForBusiness,
  type EscrowHistory, type EscrowPage, type EscrowRole,
} from "./reads";
export { handleEscrowWebhook, simulateMockFunding, type WebhookResult } from "./webhook";
export { processPayouts } from "./payouts";
export { listIssues, reconcile, resolveIssue, type IssueRow, type ReconcileResult } from "./reconcile";
export { escrowConversionRate, escrowStats, percentile, type EscrowStats } from "./stats";
export { getEscrowPartner, setEscrowPartner, configuredPartnerName, MockPartner, isPartnerName, type EscrowPartner, type PartnerName } from "./partner";
