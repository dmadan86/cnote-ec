// Signed, idempotent partner webhook ingress (ADR-019). verify -> store (partner,eventId) once -> apply, one transaction:
// a failure rolls the event row back so the partner's retry re-applies; a duplicate returns "duplicate".
import { DomainError } from "@cnote/core";
import { prisma, type Tx } from "@cnote/db";
import { storeOffers } from "./applications";
import { assertCreditEnabled } from "./config";
import { applyDpd, recordCancellation, recordDisbursal, recordRepayment, recordWriteOff } from "./loans";
import { activePartnerName, assertMockAllowed, getCreditPartner, MockPartner, mockPartnerAllowed, type PartnerEvent } from "./partner";
import { ports } from "./ports";
import type { Actor, Product } from "./types";
import { num } from "./views";

const UUID = /^[0-9a-f-]{36}$/i;

export interface WebhookResult { status: "processed" | "duplicate" | "ignored" }

type After = () => Promise<void>;

async function apply(tx: Tx, partnerName: string, e: PartnerEvent, after: After[]): Promise<WebhookResult["status"]> {
  const partner = getCreditPartner(partnerName);
  switch (e.type) {
    case "application.offered": {
      const app = await tx.creditApplication.findUnique({ where: { partner_partnerRef: { partner: partnerName, partnerRef: e.partnerRef } } });
      if (!app || !e.offers?.length || (app.status !== "submitted" && app.status !== "offered")) return "ignored";
      await storeOffers(tx, app.id, app.product as Product, partner.lender, e.offers, e.at);
      await tx.creditApplication.update({ where: { id: app.id }, data: { status: "offered" } });
      return "processed";
    }
    case "application.rejected": {
      const r = await tx.creditApplication.updateMany({
        where: { partner: partnerName, partnerRef: e.partnerRef, status: { in: ["submitted", "offered"] } },
        data: { status: "rejected", reason: e.reason ?? "rejected_by_partner", closedAt: e.at },
      });
      return r.count ? "processed" : "ignored";
    }
    case "loan.disbursed": {
      const r = await recordDisbursal(tx, { partner: partnerName, partnerRef: e.partnerRef, loanRef: e.loanRef ?? e.partnerRef, amountPaise: e.amountPaise, at: e.at });
      if (!r) return "ignored";
      if (r.created && r.loan.product === "bnpl") {
        const loan = r.loan;
        after.push(async () => {
          try { await ports().fundEscrowFromLender(loan.escrowId, num(loan.principalPaise), loan.id); } catch (err) { console.error("[credit] bnpl escrow funding failed (job will retry)", loan.id, err); }
        });
      }
      return "processed";
    }
    default: {
      const loan = await tx.creditLoan.findUnique({ where: { partner_partnerLoanRef: { partner: partnerName, partnerLoanRef: e.loanRef ?? e.partnerRef } } });
      if (!loan) return "ignored";
      if (e.type === "loan.repayment") return (await recordRepayment(tx, loan.id, { eventKey: e.eventId, amountPaise: e.amountPaise ?? 0, source: e.source ?? "borrower", paidAt: e.at })) ? "processed" : "ignored";
      if (e.type === "loan.overdue") return (await applyDpd(tx, loan, e.dpd ?? 1)) ? "processed" : "ignored";
      if (e.type === "loan.cancelled") return (await recordCancellation(tx, loan.id, { reason: "partner", at: e.at, exitAmountPaise: e.amountPaise ?? null })) ? "processed" : "ignored";
      if (e.type === "loan.written_off") { await recordWriteOff(tx, loan.id, e.at); return "processed"; }
      if (loan.status === "cancelled") return "ignored";
      // loan.closed: the partner says it is settled; reconcile our mirror to fully repaid
      const owed = Math.max(0, num(loan.totalRepayablePaise) - num(loan.repaidPaise));
      if (owed > 0) await recordRepayment(tx, loan.id, { eventKey: `close:${e.eventId}`, amountPaise: owed, source: "partner", paidAt: e.at });
      return "processed";
    }
  }
}

export async function handleCreditWebhook(partnerName: string, raw: Uint8Array, headers: Headers): Promise<WebhookResult> {
  const partner = getCreditPartner(partnerName);
  // Security audit H1: refuse while the feature is off, and accept ONLY the configured partner (a forged `mock` event must
  // never move a loan while a real partner is configured). Same not_found so nothing is revealed.
  assertCreditEnabled();
  if (partnerName !== activePartnerName() || (partnerName === "mock" && !mockPartnerAllowed())) throw new DomainError("not_found", "Unknown credit partner.", undefined, "credit.unknownCreditPartner");
  const event = partner.verifyWebhook(raw, headers);
  if (!event) throw new DomainError("unauthenticated", "Invalid webhook signature.");
  const after: After[] = [];
  const status = await prisma.$transaction(async (tx) => {
    const made = await tx.creditWebhookEvent.createMany({ skipDuplicates: true, data: [{ partner: partnerName, eventId: event.eventId, type: event.type }] });
    if (made.count === 0) return "duplicate" as const;
    return apply(tx, partnerName, event, after);
  });
  for (const f of after) await f();
  return { status };
}

/** Dev checkout: feed the accepted offer's disbursal through the real webhook path (refused in production unless CREDIT_MOCK_CHECKOUT=1). */
export async function simulateMockDisbursal(actor: Actor, applicationId: string): Promise<WebhookResult> {
  assertMockAllowed();
  if (!UUID.test(applicationId)) throw new DomainError("not_found", "Application not found.");
  const app = await prisma.creditApplication.findUnique({ where: { id: applicationId } });
  // security audit H1: only the owning business may trigger its own simulated disbursal
  if (!app || app.businessId !== actor.businessId) throw new DomainError("not_found", "Application not found.");
  if (app.partner !== "mock" || app.status !== "accepted" || !app.partnerRef) throw new DomainError("conflict", "Only an accepted mock application can be disbursed.");
  const mock = getCreditPartner("mock") as MockPartner;
  const { raw, headers } = mock.signedEvent({ eventId: `disb:${app.id}`, type: "loan.disbursed", partnerRef: app.partnerRef, loanRef: `mockloan:${app.id}` });
  return handleCreditWebhook("mock", raw, headers);
}
