import type { Band, CreditFeatures, Reason } from "./model";

export type Product = "invoice_financing" | "bnpl";
export const PRODUCTS: readonly Product[] = ["invoice_financing", "bnpl"];
export type ApplicationStatus = "submitted" | "offered" | "accepted" | "disbursed" | "rejected" | "declined" | "expired" | "failed" | "cancelled";
export const ACTIVE_APPLICATION_STATUSES: readonly ApplicationStatus[] = ["submitted", "offered", "accepted", "disbursed"];
export type LoanStatus = "active" | "overdue" | "repaid" | "written_off" | "cancelled";

export interface Actor { personId: string; businessId: string }

export interface LenderInfo {
  /** the partner is the lender of record and says so in every disclosure */
  name: string;
  grievance: { name: string; email: string; phone: string };
}

/** Key Fact Statement (RBI digital lending guidelines): shown before acceptance, stored with the offer. */
export interface Kfs {
  version: "kfs-v1";
  product: Product;
  lenderName: string;
  grievanceOfficer: { name: string; email: string; phone: string };
  principalPaise: number;
  tenorDays: number;
  /** contractual interest rate, annualised (bps) */
  aprBps: number;
  /** all-in annualised cost including fees (bps) */
  allInAprBps: number;
  interestPaise: number;
  processingFeePaise: number;
  otherFeesPaise: number;
  totalRepayablePaise: number;
  lateFeeBpsPerMonth: number;
  coolingOffDays: number;
  prepaymentCharge: string;
  /** what the borrower owes if they exit inside the cooling-off period (RBI): principal + interest accrued to the day of exit, plus fees unless waived */
  coolingOffExit?: "principal_plus_pro_rata_interest";
  /** true when the lender also returns/waives the processing and other fees on a cooling-off exit */
  coolingOffFeesWaived?: boolean;
  repayment: "escrow_release" | "buyer_instalment";
}

export interface ScoreView {
  id: string;
  businessId: string;
  score: number;
  band: Band;
  modelVersion: string;
  reasons: Reason[];
  computedAt: string;
  trigger: string;
}

export interface OfferView {
  id: string;
  amountPaise: number;
  aprBps: number;
  tenorDays: number;
  processingFeePaise: number;
  otherFeesPaise: number;
  interestPaise: number;
  totalRepayablePaise: number;
  kfs: Kfs;
  status: string;
  expiresAt: string;
}

export interface LoanView {
  id: string;
  applicationId: string;
  businessId: string;
  product: Product;
  orderId: string;
  escrowId: string;
  partner: string;
  principalPaise: number;
  aprBps: number;
  tenorDays: number;
  totalRepayablePaise: number;
  repaidPaise: number;
  outstandingPaise: number;
  status: LoanStatus;
  dpd: number;
  disbursedAt: string;
  dueAt: string;
  closedAt: string | null;
  /** end of the borrower's cooling-off window (RBI digital lending) */
  coolingOffEndsAt: string;
  /** what was owed on a cooling-off exit (cancelled loans only) */
  exitAmountPaise: number | null;
  cancelReason: string | null;
  repayments: { amountPaise: number; source: string; paidAt: string }[];
}

export interface ApplicationView {
  id: string;
  businessId: string;
  product: Product;
  orderId: string;
  escrowId: string;
  amountPaise: number;
  orderAmountPaise: number;
  tenorDays: number;
  status: ApplicationStatus;
  reason: string | null;
  partner: string;
  lenderName: string;
  createdAt: string;
  offers: OfferView[];
  loan: LoanView | null;
}

export interface EscrowFacts {
  escrowId: string;
  orderId: string;
  status: string;
  frozen: boolean;
  amountPaise: number;
  heldPaise: number;
  buyerBusinessId: string;
  sellerBusinessId: string;
}

export type { CreditFeatures };
