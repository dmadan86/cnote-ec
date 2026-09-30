// Read ports onto other modules (ADR-006: only through their public exports). Defaults live in adapters.ts; tests inject fakes.
import type { EscrowFacts } from "./types";

export interface GstSignal {
  verified: boolean;
  /** provider taxpayer status, e.g. "Active" */
  status: string | null;
  lastCheckedAt: Date | null;
  /** last filing periods, newest first (only the filed flag is used) */
  filings: { filed: boolean }[];
}
export interface TrustSignal { trustScore: number; badgeActive: boolean }
export interface EscrowHistory {
  completed: number;
  completedPaise: number;
  /** completed with no dispute freeze */
  clean: number;
  refunded: number;
}
export interface DisputeRecord { lost: number; open: number }

export interface CreditPorts {
  gst(businessId: string): Promise<GstSignal>;
  trust(businessId: string): Promise<TrustSignal>;
  escrowHistory(businessId: string): Promise<EscrowHistory>;
  disputes(businessId: string): Promise<DisputeRecord>;
  escrowFacts(escrowId: string): Promise<EscrowFacts | null>;
  fundedEscrowsForSeller(businessId: string): Promise<EscrowFacts[]>;
  /** Net proceeds to the seller after escrow fee + GST for an escrow amount. */
  sellerNetPaise(amountPaise: number): number;
  /**
   * BNPL: the partner has disbursed to the escrow collect account; ask escrow to record funding. Must be idempotent by `ref`.
   * Default: @cnote/escrow fundEscrowFromLender (true when funded or already funded).
   */
  fundEscrowFromLender(escrowId: string, amountPaise: number, ref: string): Promise<boolean>;
  /** Invoice financing: tell escrow how much of this escrow's seller proceeds belong to the lender (0 clears it). */
  assignEscrowProceeds(i: { escrowId: string; assignmentId: string; partner: string; partnerLoanRef: string; duePaise: number }): Promise<void>;
}

let overrides: Partial<CreditPorts> = {};
let defaults: CreditPorts | null = null;

export function setDefaultPorts(p: CreditPorts): void { defaults = p; }
/** Tests / composition root: override individual ports (call with {} to restore the defaults). */
export function setCreditPorts(p: Partial<CreditPorts>): void { overrides = p; }
export function ports(): CreditPorts {
  if (!defaults) throw new Error("credit ports not initialised");
  return { ...defaults, ...overrides };
}
