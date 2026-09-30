// Real NBFC adapter stub: money and underwriting calls throw until a partner is contracted and credentialed (ADR-019 open item).
// Webhook verification is real (HMAC-SHA256 hex over the raw body, CREDIT_WEBHOOK_SECRET) so ingress can be exercised.
import { DomainError } from "@cnote/core";
import type { LenderInfo } from "../types";
import { verifySigned } from "./events";
import type { CreditPartner, PartnerEvent } from "./types";

const notConfigured = (): never => { throw new DomainError("conflict", "Credit partner is not configured."); };

export class NbfcPartnerStub implements CreditPartner {
  readonly name = "nbfc_partner" as const;
  readonly lender: LenderInfo = {
    name: process.env.CREDIT_LENDER_NAME ?? "Lending partner (not configured)",
    grievance: { name: process.env.CREDIT_GRIEVANCE_NAME ?? "Grievance Officer", email: process.env.CREDIT_GRIEVANCE_EMAIL ?? "grievance@example.invalid", phone: process.env.CREDIT_GRIEVANCE_PHONE ?? "" },
  };
  submitApplication(): never { return notConfigured(); }
  getOffers(): never { return notConfigured(); }
  acceptOffer(): never { return notConfigured(); }
  getDisbursementStatus(): never { return notConfigured(); }
  listRepayments(): never { return notConfigured(); }
  verifyWebhook(raw: Uint8Array, headers: Headers): PartnerEvent | null { return verifySigned(process.env.CREDIT_WEBHOOK_SECRET, raw, headers); }
}
