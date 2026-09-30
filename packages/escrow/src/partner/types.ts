// Payment Aggregator partner port (ADR-012 option 2): the partner holds the funds, the Platform orchestrates milestones.
export type PartnerName = "mock" | "razorpay_route" | "cashfree";
export const PARTNER_NAMES: readonly PartnerName[] = ["mock", "razorpay_route", "cashfree"];
export const isPartnerName = (v: unknown): v is PartnerName => typeof v === "string" && (PARTNER_NAMES as readonly string[]).includes(v);

export interface CollectRequest {
  escrowId: string;
  orderId: string;
  amountPaise: number;
  buyer: { businessId: string; name?: string };
  expiresAt: Date;
}
export interface CollectResponse {
  /** partner-side reference (virtual account / payment link id) */
  partnerRef: string;
  /** hosted checkout / collect link (UPI, NEFT, net banking). No card data touches us (ADR-010). */
  checkoutUrl: string;
  virtualAccount?: { accountNumber: string; ifsc: string };
}
export interface TransferRequest {
  /** our EscrowPayout id: the partner idempotency key */
  transferId: string;
  escrowId: string;
  amountPaise: number;
  beneficiaryBusinessId: string;
  purpose: "seller_payout" | "buyer_refund" | "lender_repayment";
  /** lender_repayment: "<partner>:<loan ref>" so the PA routes the transfer to the lender's collection account */
  beneficiaryRef?: string;
}
export interface TransferResult { partnerRef: string; status: "settled" | "pending" }

export interface StatementEntry {
  partnerRef: string;
  /** our escrow id when the partner echoes our reference */
  escrowRef: string | null;
  kind: "collect" | "payout" | "refund";
  amountPaise: number;
  at: string;
}

export type ParsedWebhookType = "collect.captured" | "payout.settled" | "payout.failed" | "ignored";
export interface ParsedEscrowWebhook {
  eventId: string;
  type: ParsedWebhookType;
  escrowId?: string;
  payoutId?: string;
  partnerRef?: string;
  amountPaise?: number;
  /** payload with payer identifiers stripped (stored for audit) */
  redacted: Record<string, unknown>;
}

export interface EscrowPartner {
  name: PartnerName;
  /** false = the statement is a best-effort echo (mock): "missing at partner" is not flagged. */
  authoritativeStatement: boolean;
  createCollect(req: CollectRequest): Promise<CollectResponse>;
  releasePayout(req: TransferRequest): Promise<TransferResult>;
  refund(req: TransferRequest): Promise<TransferResult>;
  /** null = signature invalid. Throws DomainError("validation") for a valid signature over an unparseable body. */
  verifyWebhook(raw: Uint8Array | string, headers: Headers | Record<string, string | undefined>): ParsedEscrowWebhook | null;
  fetchStatement(range: { from: Date; to: Date }): Promise<StatementEntry[]>;
}
