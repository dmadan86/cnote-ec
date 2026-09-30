// NBFC partner port (ADR-019). The partner is the lender of record: it underwrites, disburses, collects and reports.
import type { LenderInfo, Product } from "../types";

export type PartnerName = "mock" | "nbfc_partner";
export const PARTNER_NAMES: readonly PartnerName[] = ["mock", "nbfc_partner"];
export const isPartnerName = (v: string): v is PartnerName => (PARTNER_NAMES as readonly string[]).includes(v);

/** Data minimisation (DPDP / RBI): features + score only. No GSTIN, no raw returns, no contact details. */
export interface PartnerApplicationRequest {
  applicationRef: string;
  product: Product;
  amountPaise: number;
  tenorDays: number;
  borrowerRef: string;
  score: { value: number; band: string; modelVersion: string; reasonCodes: string[] };
  features: Record<string, number | boolean | null>;
  collateral: { kind: "escrow"; escrowRef: string; orderRef: string; orderAmountPaise: number };
}

export interface PartnerOffer {
  offerRef: string;
  amountPaise: number;
  aprBps: number;
  tenorDays: number;
  processingFeePaise: number;
  otherFeesPaise: number;
  expiresAt?: Date;
}

export interface PartnerSubmitResult {
  partnerRef: string;
  status: "offered" | "pending" | "rejected";
  offers: PartnerOffer[];
  reason?: string;
}
export interface PartnerAcceptResult { status: "accepted" | "failed"; reason?: string }
export interface PartnerDisbursement { status: "pending" | "disbursed" | "failed"; loanRef?: string; disbursedAt?: Date }
export interface PartnerRepayment { eventKey: string; amountPaise: number; paidAt: Date; source: "borrower" | "escrow_release" | "partner" }

export type PartnerEventType = "application.offered" | "application.rejected" | "loan.disbursed" | "loan.repayment" | "loan.overdue" | "loan.closed" | "loan.written_off";
export interface PartnerEvent {
  eventId: string;
  type: PartnerEventType;
  /** the partner's reference for the application (also identifies the loan for disbursal) */
  partnerRef: string;
  loanRef?: string;
  offers?: PartnerOffer[];
  amountPaise?: number;
  dpd?: number;
  reason?: string;
  source?: PartnerRepayment["source"];
  at: Date;
}

export interface CreditPartner {
  readonly name: PartnerName;
  readonly lender: LenderInfo;
  submitApplication(req: PartnerApplicationRequest): Promise<PartnerSubmitResult>;
  getOffers(partnerRef: string): Promise<PartnerOffer[]>;
  acceptOffer(partnerRef: string, offerRef: string, acceptance: { acceptedAt: Date; personRef: string }): Promise<PartnerAcceptResult>;
  getDisbursementStatus(partnerRef: string): Promise<PartnerDisbursement>;
  listRepayments(loanRef: string): Promise<PartnerRepayment[]>;
  /** null when the signature is bad or the body is malformed */
  verifyWebhook(raw: Uint8Array, headers: Headers): PartnerEvent | null;
}
