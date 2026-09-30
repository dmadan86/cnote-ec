import { type ModuleWorker } from "@cnote/core";
import { creditEnabled } from "./config";
import { expireOffers, onEscrowRefunded, onEscrowReleased, recordAssignmentSettlement, retryBnplFunding, syncEscrowAssignment, updateDpd } from "./loans";
import { computeAndStoreScore, recomputeAllScores } from "./score";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;

const recompute = (trigger: string) => async (businessId: string | null | undefined): Promise<void> => {
  if (!creditEnabled() || !businessId) return;
  await computeAndStoreScore(businessId, trigger);
};

/**
 * Handlers are idempotent (at-least-once). Score recomputes run only when CREDIT_ENABLED and only for businesses with an active
 * `credit_underwriting` consent. Loan-book mirroring (webhooks, DPD, escrow assignment) is deliberately not flag-gated:
 * loans that already exist keep moving.
 */
export const worker: ModuleWorker = {
  name: "credit",
  handlers: {
    EscrowReleased: async (e) => { await onEscrowReleased(e.payload.escrowId); await recompute("EscrowReleased")(e.payload.sellerBusinessId); },
    EscrowRefunded: async (e) => { await onEscrowRefunded(e.payload.escrowId); await recompute("EscrowRefunded")(e.payload.buyerBusinessId); },
    DisputeResolved: async (e) => recompute("DisputeResolved")(e.payload.faultBusinessId),
    BusinessVerified: async (e) => recompute("BusinessVerified")(e.payload.businessId),
    TrustScoreChanged: async (e) => recompute("TrustScoreChanged")(e.payload.businessId),
    // invoice financing: escrow pays the lender first at release and reports it; keep escrow's claim in step with the loan
    EscrowLenderRepaid: async (e) => void (await recordAssignmentSettlement({ assignmentId: e.payload.assignmentId, amountPaise: e.payload.amountPaise, reference: e.payload.payoutId })),
    CreditDisbursed: async (e) => void (await syncEscrowAssignment(e.payload.loanId)),
    CreditRepaid: async (e) => void (await syncEscrowAssignment(e.payload.loanId)),
    CreditCancelled: async (e) => void (await syncEscrowAssignment(e.payload.loanId)),
    CreditClosed: async (e) => void (await syncEscrowAssignment(e.payload.loanId)),
  },
  jobs: [
    { name: "credit.nightly-scores", everyMs: 24 * HOUR_MS, run: async () => { if (creditEnabled()) await recomputeAllScores(); } },
    { name: "credit.update-dpd", everyMs: HOUR_MS, run: async () => void (await updateDpd()) },
    { name: "credit.expire-offers", everyMs: 15 * MIN_MS, run: async () => void (await expireOffers()) },
    { name: "credit.bnpl-funding", everyMs: 5 * MIN_MS, run: async () => void (await retryBnplFunding()) },
  ],
};
