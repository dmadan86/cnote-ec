// Deterministic in-process partner for dev and tests. Stateless: the partner ref encodes what the offer needs, so getOffers
// works across processes. `signedEvent` builds the exact signed webhook body a real partner would send.
import { DomainError } from "@cnote/core";
import type { LenderInfo } from "../types";
import { hmacHex, verifySigned } from "./events";
import type { CreditPartner, PartnerAcceptResult, PartnerApplicationRequest, PartnerDisbursement, PartnerEvent, PartnerOffer, PartnerRepayment, PartnerSubmitResult } from "./types";

export const mockSecret = (): string => process.env.CREDIT_WEBHOOK_SECRET || "mock-credit-webhook-secret";
export const MOCK_LENDER: LenderInfo = {
  name: "Sample NBFC Ltd (mock lender)",
  grievance: { name: "Grievance Officer, Sample NBFC", email: "grievance@sample-nbfc.example", phone: "+91 80 0000 0000" },
};

/** Deterministic pricing: better score, lower rate. Below 500 the mock declines; below 550 it approves 60%. */
export function mockPricing(score: number, requestedPaise: number, tenorDays: number): { approve: boolean; offer?: Omit<PartnerOffer, "offerRef"> } {
  if (score < 500) return { approve: false };
  const amountPaise = score < 550 ? Math.floor(requestedPaise * 0.6) : requestedPaise;
  const aprBps = Math.min(3600, Math.max(1200, 3600 - (score - 500) * 6));
  return { approve: true, offer: { amountPaise, aprBps, tenorDays, processingFeePaise: Math.round(amountPaise / 100), otherFeesPaise: 0 } };
}

const REF = /^mock:([^:]+):(\d+):(\d+):(\d+)$/;

export class MockPartner implements CreditPartner {
  readonly name = "mock" as const;
  readonly lender = MOCK_LENDER;

  async submitApplication(req: PartnerApplicationRequest): Promise<PartnerSubmitResult> {
    const partnerRef = `mock:${req.applicationRef}:${req.amountPaise}:${req.tenorDays}:${req.score.value}`;
    const p = mockPricing(req.score.value, req.amountPaise, req.tenorDays);
    if (!p.approve || !p.offer) return { partnerRef, status: "rejected", offers: [], reason: "score_below_partner_threshold" };
    return { partnerRef, status: "offered", offers: [{ ...p.offer, offerRef: `${partnerRef}:o1` }] };
  }

  async getOffers(partnerRef: string): Promise<PartnerOffer[]> {
    const m = REF.exec(partnerRef);
    if (!m) return [];
    const p = mockPricing(Number(m[4]), Number(m[2]), Number(m[3]));
    return p.offer ? [{ ...p.offer, offerRef: `${partnerRef}:o1` }] : [];
  }

  async acceptOffer(partnerRef: string, offerRef: string, _acceptance?: { acceptedAt: Date; personRef: string }): Promise<PartnerAcceptResult> {
    return offerRef.startsWith(partnerRef) ? { status: "accepted" } : { status: "failed", reason: "unknown_offer" };
  }

  async getDisbursementStatus(): Promise<PartnerDisbursement> { return { status: "pending" }; }
  async listRepayments(): Promise<PartnerRepayment[]> { return []; }

  verifyWebhook(raw: Uint8Array, headers: Headers): PartnerEvent | null { return verifySigned(mockSecret(), raw, headers); }

  /** Body + headers of a signed partner event (dev checkout button and tests feed this through handleCreditWebhook). */
  signedEvent(e: { eventId: string; type: PartnerEvent["type"]; partnerRef: string; at?: Date } & Partial<Omit<PartnerEvent, "at">>): { raw: Uint8Array; headers: Headers } {
    const body = JSON.stringify({ ...e, at: (e.at ?? new Date()).toISOString() });
    const raw = new TextEncoder().encode(body);
    return { raw, headers: new Headers({ "x-credit-signature": hmacHex(mockSecret(), raw) }) };
  }
}

export function assertMockAllowed(): void {
  if (process.env.NODE_ENV === "production" && process.env.CREDIT_MOCK_CHECKOUT !== "1") throw new DomainError("forbidden", "The mock credit partner is disabled in production.");
}
