// Evidence collection (order, quote, conversation, invoice, quality checks via ports) and the async AI brief job (ADR-013).
import { briefDispute, getDecisionMeta, type BriefDisputeInput, type DisputeBriefEvidence } from "@cnote/ai";
import { DomainError, emit } from "@cnote/core";
import { getBuyerEnquiry, getConversation, getEnquirySummary, getOrder, type OrderView } from "@cnote/enquiry";
import { prisma } from "@cnote/db";
import { disputeConfig } from "./config";
import { enqueueBrief } from "./jobs";
import { lockDispute, status } from "./internal";
import { escrowPort, qualityPort } from "./ports";
import { assertTransition, faultFor, isActive, routeBrief } from "./state";

const inr = (paise: number | null) => (paise === null ? "not recorded" : `Rs ${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
const ist = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
const MAX_MESSAGES = 60;

/** Facts about the order's lifecycle that matter for non-delivery style claims. Phrases are matched by the heuristic brief. */
export function orderFacts(o: Pick<OrderView, "status" | "buyerConfirmedAt" | "sellerConfirmedAt" | "quantity" | "unit" | "pricePaise" | "totalPaise" | "createdAt">): string {
  const facts = [
    `Order recorded ${ist(o.createdAt)}: ${o.quantity ?? "unspecified"} ${o.unit ?? "units"} at ${inr(o.pricePaise)} per unit, total ${inr(o.totalPaise)}.`,
    o.buyerConfirmedAt ? `Buyer confirmed the terms on ${ist(o.buyerConfirmedAt)}.` : "Buyer has not confirmed the terms.",
    o.sellerConfirmedAt ? `Seller confirmed the terms on ${ist(o.sellerConfirmedAt)}.` : "Seller has not confirmed the terms.",
    `Order status: ${o.status}.`,
  ];
  if (o.status === "confirmed") facts.push("Seller never marked the order dispatched.");
  if (o.status === "dispatched") facts.push("Seller marked the order dispatched; the buyer has not marked it delivered.");
  if (o.status === "delivered" || o.status === "completed") facts.push(`Buyer marked the order ${o.status}.`);
  return facts.join(" ");
}

/** The order's conversation, through the buyer's enquiry view (which does not reveal any contact details). */
async function conversationIdOf(order: OrderView, openerBusinessId: string): Promise<string | null> {
  if (!order.enquiryId || !order.matchId) return null; // network (ONDC) orders have no conversation
  const buyerId = order.role === "buyer" ? openerBusinessId : order.counterparty.businessId;
  const enquiry = await getBuyerEnquiry(buyerId, order.enquiryId);
  return enquiry?.matches.find((m) => m.id === order.matchId)?.conversationId ?? null;
}

interface AutoRow { source: string; sourceRef: string; text: string }

/**
 * Idempotently attaches system evidence (unique per dispute + sourceRef). Uses only public functions of other modules,
 * as the dispute opener. Returns the number of rows added.
 */
export async function collectEvidence(disputeId: string): Promise<number> {
  const d = await prisma.dispute.findUnique({ where: { id: disputeId } });
  if (!d || !isActive(status(d))) return 0;
  const opener = { personId: d.openedByPersonId, businessId: d.openedByBusinessId };
  const order = await getOrder(opener, d.orderId);
  if (!order) return 0;

  const rows: AutoRow[] = [{ source: "auto:order", sourceRef: `order:${order.id}`, text: orderFacts(order) }];

  const [conversationId, enquiry] = await Promise.all([conversationIdOf(order, opener.businessId), order.enquiryId ? getEnquirySummary(order.enquiryId) : Promise.resolve(null)]);
  const convo = conversationId ? await getConversation(opener, conversationId) : null;
  if (convo) {
    for (const q of convo.quotes) {
      rows.push({
        source: "auto:quote", sourceRef: `quote:${q.id}`,
        text: `Seller quote of ${ist(q.createdAt)}: ${q.quantity} ${q.unit} at ${inr(q.pricePaise)} per unit${q.leadTimeDays != null ? `, lead time ${q.leadTimeDays} days` : ""}${q.validUntil ? `, valid until ${q.validUntil}` : ""}.${q.notes ? ` Notes: ${q.notes}` : ""}`,
      });
    }
    if (convo.messages.length) {
      const tail = convo.messages.slice(-MAX_MESSAGES);
      const lines = tail.map((m) => `[${ist(m.createdAt)}] ${enquiry && m.senderPersonId === enquiry.buyerPersonId ? "Buyer" : "Seller"}: ${m.body}`);
      rows.push({ source: "auto:messages", sourceRef: "messages", text: `Conversation before the order (${tail.length} of ${convo.messages.length} messages):\n${lines.join("\n")}` });
    }
  }

  const escrow = await escrowPort().getEscrowForOrder(order.id);
  if (escrow) {
    rows.push({ source: "auto:escrow", sourceRef: `escrow:${escrow.escrowId}`, text: `Escrow ${escrow.status}: ${inr(escrow.heldPaise)} held.` });
    if (escrow.invoice) rows.push({ source: "auto:invoice", sourceRef: `invoice:${escrow.invoice.number}`, text: `GST invoice ${escrow.invoice.number} for ${inr(escrow.invoice.totalPaise)}.` });
  }
  for (const c of await qualityPort().listChecksForOrder(order.id)) {
    rows.push({ source: "auto:quality", sourceRef: `quality:${c.id}`, text: `Pre-dispatch quality check (advisory): ${c.verdict} at confidence ${c.confidence.toFixed(2)}. ${c.summary}` });
  }

  const res = await prisma.disputeEvidence.createMany({
    data: rows.map((r) => ({ disputeId, party: "system" as const, kind: "system" as const, text: r.text, source: r.source, sourceRef: r.sourceRef })),
    skipDuplicates: true,
  });
  return res.count;
}

/** Moves open -> evidence (response window over or counterparty answered) and enqueues the brief. Idempotent. */
export async function queueBrief(disputeId: string, bucket = ""): Promise<boolean> {
  const moved = await prisma.$transaction(async (tx) => {
    await lockDispute(tx, disputeId);
    const d = await tx.dispute.findUnique({ where: { id: disputeId } });
    if (!d || status(d) !== "open") return false;
    await tx.dispute.update({ where: { id: disputeId }, data: { status: "evidence", briefQueuedAt: new Date() } });
    return true;
  });
  if (moved) await enqueueBrief(disputeId, bucket);
  return moved;
}

/** Queue consumer: builds the brief input from the evidence on file, runs @cnote/ai briefDispute, routes the result. */
export async function runBrief(disputeId: string): Promise<"briefed" | "skipped"> {
  let d = await prisma.dispute.findUnique({ where: { id: disputeId } });
  if (!d || status(d) !== "evidence") return "skipped"; // already briefed / withdrawn / resolved: idempotent
  await collectEvidence(disputeId);
  d = await prisma.dispute.findUniqueOrThrow({ where: { id: disputeId } });

  const opener = { personId: d.openedByPersonId, businessId: d.openedByBusinessId };
  const order = await getOrder(opener, d.orderId);
  if (!order) throw new DomainError("not_found", "Order not found");
  const buyerId = order.role === "buyer" ? opener.businessId : order.counterparty.businessId;
  const sellerId = order.role === "seller" ? opener.businessId : order.counterparty.businessId;

  const evidenceRows = await prisma.disputeEvidence.findMany({ where: { disputeId, purgedAt: null }, orderBy: { createdAt: "asc" } });
  const evidence: DisputeBriefEvidence[] = evidenceRows.map((e) => ({
    id: e.id, kind: e.kind, party: e.party === "staff" ? "system" : e.party, text: e.text ?? "",
  }));
  const qualityChecks = (await qualityPort().listChecksForOrder(order.id)).flatMap((c) => {
    const row = evidenceRows.find((e) => e.sourceRef === `quality:${c.id}`);
    return row ? [{ id: row.id, verdict: c.verdict, confidence: c.confidence, summary: c.summary }] : [];
  });

  // Quote (if any) from the conversation, via enquiry's public view.
  const conversationId = await conversationIdOf(order, opener.businessId);
  const convo = conversationId ? await getConversation(opener, conversationId) : null;
  const quote = order.quoteId ? convo?.quotes.find((q) => q.id === order.quoteId) : convo?.quotes.at(-1);

  const input: BriefDisputeInput = {
    claimedType: d.type,
    claimedAmountPaise: d.amountPaise === null ? null : Number(d.amountPaise),
    atStakePaise: Number(d.atStakePaise),
    order: { totalPaise: order.totalPaise, quantity: order.quantity, unit: order.unit, pricePaise: order.pricePaise, status: order.status },
    quote: quote ? { pricePaise: quote.pricePaise, quantity: quote.quantity, unit: quote.unit, leadTimeDays: quote.leadTimeDays, notes: quote.notes } : null,
    evidence, qualityChecks,
    counterpartyResponded: d.counterpartyRespondedAt !== null,
  };
  // Provider errors propagate: the queue retries with backoff, then dead-letters (ops replay).
  const r = await briefDispute(input, { type: "dispute", id: disputeId });
  const cfg = disputeConfig();
  const route = routeBrief({ type: r.classifiedType, claimedPaise: input.claimedAmountPaise, recommendation: r.recommendation, confidence: r.confidence, needsReview: r.needsReview }, cfg);

  // The AI decision row holds who answered; the brief copies it for the adjudicator screen.
  const meta = await getDecisionMeta(r.decisionId);

  await prisma.$transaction(async (tx) => {
    await lockDispute(tx, disputeId);
    const cur = await tx.dispute.findUniqueOrThrow({ where: { id: disputeId } });
    if (status(cur) !== "evidence") return; // raced with a withdrawal or another run
    const last = await tx.disputeBrief.findFirst({ where: { disputeId }, orderBy: { version: "desc" }, select: { version: true } });
    await tx.disputeBrief.create({
      data: {
        disputeId, version: (last?.version ?? 0) + 1, classifiedType: r.classifiedType, summary: r.summary, citedEvidenceIds: r.citedEvidenceIds, specChecks: r.specChecks as unknown as object,
        specVerdict: r.specVerdict, recommendedOutcome: r.recommendation.outcome, recommendedRefundPaise: BigInt(r.recommendation.refundPaise),
        recommendedReleasePaise: BigInt(r.recommendation.releasePaise), rationale: r.recommendation.rationale, confidence: r.confidence,
        autoResolvable: route.autoResolvable, needsReview: r.needsReview, evidenceCount: evidence.length, aiDecisionId: r.decisionId,
        provider: meta?.provider ?? "unknown", modelId: meta?.modelId ?? "unknown", promptVersion: meta?.promptVersion ?? "unknown",
      },
    });
    assertTransition("evidence", "brief_ready");
    const now = new Date();
    await tx.dispute.update({ where: { id: disputeId }, data: { status: "brief_ready", briefReadyAt: now } });
    const next = route.autoResolvable ? "auto_resolved" : "awaiting_adjudication";
    assertTransition("brief_ready", next);
    await tx.dispute.update({
      where: { id: disputeId },
      data: route.autoResolvable
        ? {
            status: next, proposedOutcome: r.recommendation.outcome, proposedRefundPaise: BigInt(r.recommendation.refundPaise), proposedReleasePaise: BigInt(r.recommendation.releasePaise),
            proposedFaultBusinessId: faultFor(r.recommendation.outcome, buyerId, sellerId), escalationDeadline: new Date(now.getTime() + cfg.escalationHours * 3_600_000),
          }
        : { status: next },
    });
    await emit(tx, "DisputeBriefReady", { type: "dispute", id: disputeId }, {
      disputeId, orderId: cur.orderId, recommendation: r.recommendation.outcome, confidence: r.confidence, autoResolvable: route.autoResolvable,
    });
  });
  return "briefed";
}
