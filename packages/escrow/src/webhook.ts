// Partner webhook ingress (ADR-012). Signature verified by the partner adapter, each event stored once (provider,eventId)
// and applied in the same transaction, so a retry after a failure re-applies and a duplicate is a no-op.
// Mount as POST /v1/webhooks/escrow/:provider in apps/api, passing the RAW body bytes and the request headers.
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import type { Actor } from "@cnote/enquiry";
import { assertEscrowEnabled } from "./config";
import { applyFundingTx, openIssue } from "./escrow";
import { activePartnerName, getEscrowPartner, isPartnerName, MockPartner, mockPartnerAllowed, type ParsedEscrowWebhook } from "./partner";
import { markTransferFailedTx, settleTransferTx } from "./payouts";

export interface WebhookResult { status: "processed" | "duplicate"; eventId: string; type: string; outcome: string }

const UUID = /^[0-9a-f-]{36}$/i;

export async function handleEscrowWebhook(provider: string, rawBody: Uint8Array | string, headers: Headers | Record<string, string | undefined>): Promise<WebhookResult> {
  if (!isPartnerName(provider)) throw new DomainError("not_found", "Unknown escrow provider");
  // Security audit H1: the feature flag gates ingress, and ONLY the configured partner may post (a forged `mock` event, signed
  // with a guessable secret, must never move money while a real partner is configured). Same 404 so nothing is revealed.
  assertEscrowEnabled();
  if (provider !== activePartnerName()) throw new DomainError("not_found", "Unknown escrow provider");
  if (provider === "mock" && !mockPartnerAllowed()) throw new DomainError("not_found", "Unknown escrow provider");
  const parsed = getEscrowPartner(provider).verifyWebhook(rawBody, headers);
  if (!parsed) throw new DomainError("unauthenticated", "Invalid webhook signature");
  return prisma.$transaction(async (tx) => {
    const ins = await tx.escrowWebhookEvent.createMany({ data: [{ provider, eventId: parsed.eventId, type: parsed.type, payload: parsed.redacted as object }], skipDuplicates: true });
    if (ins.count === 0) {
      const prev = await tx.escrowWebhookEvent.findUnique({ where: { provider_eventId: { provider, eventId: parsed.eventId } } });
      return { status: "duplicate", eventId: parsed.eventId, type: parsed.type, outcome: prev?.outcome ?? "unknown" } as WebhookResult;
    }
    const outcome = await apply(tx, provider, parsed);
    await tx.escrowWebhookEvent.update({ where: { provider_eventId: { provider, eventId: parsed.eventId } }, data: { outcome, processedAt: new Date() } });
    return { status: "processed", eventId: parsed.eventId, type: parsed.type, outcome } as WebhookResult;
  });
}

async function apply(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], provider: string, p: ParsedEscrowWebhook): Promise<string> {
  switch (p.type) {
    case "collect.captured": {
      if (!p.escrowId || !UUID.test(p.escrowId) || p.amountPaise === undefined) return "invalid";
      const e = await tx.escrowAgreement.findUnique({ where: { id: p.escrowId }, select: { id: true, partner: true } });
      if (!e) {
        await openIssue(tx, { dedupeKey: `unknown_escrow:${p.eventId}`, kind: "missing_in_ledger", partnerRef: p.partnerRef ?? null, actualPaise: p.amountPaise, detail: `Partner collected a payment for unknown escrow ${p.escrowId}.` });
        return "unknown_escrow";
      }
      // an event from provider X may only touch escrows opened with provider X
      if (e.partner !== provider) return "partner_mismatch";
      return applyFundingTx(tx, p.escrowId, p.amountPaise, p.partnerRef ?? null);
    }
    case "payout.settled":
      if (!p.payoutId) return "invalid";
      if (!(await payoutOwnedBy(tx, provider, p.payoutId))) return "partner_mismatch";
      return settleTransferTx(tx, p.payoutId, p.partnerRef ?? null);
    case "payout.failed":
      if (!p.payoutId) return "invalid";
      if (!(await payoutOwnedBy(tx, provider, p.payoutId))) return "partner_mismatch";
      return (await markTransferFailedTx(tx, p.payoutId, "partner reported failure")) ? "retry_queued" : "invalid";
    default:
      return "ignored";
  }
}

/** True when the payout exists and belongs to an escrow opened with this provider (unknown ids fall through to the apply path's own handling). */
async function payoutOwnedBy(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], provider: string, payoutId: string): Promise<boolean> {
  if (!UUID.test(payoutId)) return true;
  const row = await tx.escrowPayout.findUnique({ where: { id: payoutId }, select: { escrow: { select: { partner: true } } } });
  return !row || row.escrow.partner === provider;
}

/**
 * Dev/test checkout: only with the mock partner (and never in production unless ESCROW_MOCK_CHECKOUT=1). Pays the buyer's
 * escrow by sending the SAME signed webhook a real partner would, so the whole ingress path is exercised.
 */
export async function simulateMockFunding(actor: Actor, orderId: string): Promise<WebhookResult> {
  assertEscrowEnabled();
  if (process.env.NODE_ENV === "production" && process.env.ESCROW_MOCK_CHECKOUT !== "1") throw new DomainError("forbidden", "Mock checkout is disabled.");
  if (!UUID.test(orderId)) throw new DomainError("not_found", "Escrow not found");
  const e = await prisma.escrowAgreement.findUnique({ where: { orderId } });
  if (!e || e.buyerBusinessId !== actor.businessId) throw new DomainError("not_found", "Escrow not found");
  if (e.partner !== "mock") throw new DomainError("forbidden", "Mock checkout only works with the mock partner.");
  if (e.status !== "awaiting_funding") throw new DomainError("conflict", `Escrow is ${e.status}; nothing to pay.`);
  const partner = getEscrowPartner("mock");
  if (!(partner instanceof MockPartner)) throw new DomainError("forbidden", "Mock checkout only works with the mock partner.");
  const { rawBody, headers } = partner.simulateCollect(e.id, Number(e.amountPaise));
  return handleEscrowWebhook("mock", rawBody, headers);
}
