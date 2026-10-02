// Conversations between the buyer business and the matched seller business (ADR-007).
import { DomainError, emit, rateLimit } from "@cnote/core";
import { prisma, type Conversation, type Enquiry, type Match } from "@cnote/db";
import { checkAttachments, discardStored, MAX_QUOTE_ATTACHMENTS, MAX_QUOTE_ATTACHMENT_BYTES, storeAttachmentBytes, type AttachmentUpload } from "./attachments";
import { recordOrderTx } from "./orders";
import { messageSchema } from "./schemas";
import { quoteSchema, toQuoteView, type QuoteTermsInput } from "./quotes";
import { profiles } from "./support";
import type { Actor, ConversationView } from "./types";

type Loaded = Conversation & { match: Match & { enquiry: Enquiry } };

/** Loads a conversation and checks membership: only the two businesses on the match may access it. */
async function loadForActor(actor: Actor, conversationId: string): Promise<{ c: Loaded; role: "buyer" | "seller" } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) return null;
  const c = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { match: { include: { enquiry: true } } } });
  if (!c) return null;
  if (actor.businessId === c.match.enquiry.buyerBusinessId) return { c, role: "buyer" };
  if (actor.businessId === c.match.sellerBusinessId) return { c, role: "seller" };
  return null; // not a participant: indistinguishable from not found
}

async function requireParticipant(actor: Actor, conversationId: string) {
  const r = await loadForActor(actor, conversationId);
  if (!r) throw new DomainError("not_found", "Conversation not found");
  if (r.c.match.status !== "accepted") throw new DomainError("conflict", "This conversation is closed.");
  return r;
}

export async function getConversation(actor: Actor, conversationId: string): Promise<ConversationView | null> {
  const r = await loadForActor(actor, conversationId);
  if (!r) return null;
  const { c, role } = r;
  // a refunded lead is closed for the seller: the conversation (and the buyer's details in it) is no longer readable (security audit M2)
  if (role === "seller" && c.match.status === "refunded") return null;
  const [messages, quotes, deal, sellerWon, profs] = await Promise.all([
    prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: "desc" }, take: 500 }),
    prisma.quote.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } }),
    // the buyer sees authoritative reports only: a seller's "won" is a claim awaiting the buyer's confirmation (security audit M7)
    prisma.dealReport.findFirst({ where: { matchId: c.matchId, ...(role === "buyer" ? { NOT: { outcome: "won", reportedByBusinessId: c.match.sellerBusinessId } } : {}) }, orderBy: { createdAt: "desc" } }),
    prisma.dealReport.findFirst({ where: { matchId: c.matchId, outcome: "won", reportedByBusinessId: c.match.sellerBusinessId }, select: { id: true } }),
    profiles([c.match.enquiry.buyerBusinessId, c.match.sellerBusinessId]),
  ]);
  return {
    id: c.id,
    matchId: c.matchId,
    enquiryId: c.match.enquiryId,
    enquiryTitle: c.match.enquiry.title,
    buyer: { businessId: c.match.enquiry.buyerBusinessId, name: profs.get(c.match.enquiry.buyerBusinessId)?.name ?? "Buyer" },
    seller: { businessId: c.match.sellerBusinessId, name: profs.get(c.match.sellerBusinessId)?.name ?? "Seller" },
    messages: messages.reverse().map((m) => ({ id: m.id, senderPersonId: m.senderPersonId, body: m.body, createdAt: m.createdAt.toISOString() })),
    quotes: quotes.map(toQuoteView),
    dealReported: deal?.outcome ?? null,
    sellerClaimedWon: !!sellerWon,
    role,
  };
}

export async function sendMessage(actor: Actor, conversationId: string, body: string): Promise<void> {
  const text = messageSchema.parse(body);
  await requireParticipant(actor, conversationId);
  if (!(await rateLimit(`msg:${actor.personId}`, 30, 60))) throw new DomainError("rate_limited", "You are sending messages too fast. Wait a moment.");
  await prisma.$transaction(async (tx) => {
    const m = await tx.message.create({ data: { conversationId, senderPersonId: actor.personId, body: text } });
    await emit(tx, "MessageSent", { type: "conversation", id: conversationId }, { conversationId, messageId: m.id, senderPersonId: actor.personId });
  });
}

export async function sendQuote(
  actor: Actor,
  conversationId: string,
  quote: { pricePaise: number; quantity: number; unit: string; leadTimeDays?: number | null; notes?: string | null; validUntil?: string | null; attachments?: AttachmentUpload[] | null } & QuoteTermsInput,
): Promise<{ quoteId: string }> {
  const q = quoteSchema.parse(quote);
  const files = checkAttachments(quote.attachments, MAX_QUOTE_ATTACHMENTS, MAX_QUOTE_ATTACHMENT_BYTES);
  const { c, role } = await requireParticipant(actor, conversationId);
  if (role !== "seller") throw new DomainError("forbidden", "Only the seller can send a quote.");
  const stored = await storeAttachmentBytes(c.match.enquiryId, files);
  try {
  return await prisma.$transaction(async (tx) => {
    const row = await tx.quote.create({
      data: {
        conversationId,
        sellerBusinessId: actor.businessId,
        pricePaise: BigInt(q.pricePaise),
        quantity: q.quantity,
        unit: q.unit,
        leadTimeDays: q.leadTimeDays,
        notes: q.notes,
        validUntil: q.validUntil ? new Date(q.validUntil) : null,
        moq: q.moq,
        moqUnit: q.moqUnit,
        deliveryTerms: q.deliveryTerms,
        deliveryNote: q.deliveryNote,
        deliveryChargePaise: q.deliveryChargePaise == null ? null : BigInt(q.deliveryChargePaise),
        paymentTerms: q.paymentTerms,
        paymentNote: q.paymentNote,
        gstIncluded: q.gstIncluded,
      },
    });
    if (stored.length) {
      await tx.enquiryAttachment.createMany({
        data: stored.map((s) => ({ id: s.id, enquiryId: c.match.enquiryId, quoteId: row.id, uploadedByBusiness: actor.businessId, key: s.key, fileName: s.fileName, mimeType: s.mimeType, sizeBytes: s.sizeBytes, createdAt: s.createdAt })),
      });
    }
    await emit(tx, "QuoteSent", { type: "conversation", id: conversationId }, {
      quoteId: row.id, conversationId, sellerBusinessId: actor.businessId, pricePaise: q.pricePaise, quantity: q.quantity,
    });
    return { quoteId: row.id };
  });
  } catch (err) {
    await discardStored(stored);
    throw err;
  }
}

/**
 * One-tap "did this close?" (ADR-007). Either party; append-only, latest report wins in the UI.
 * Security audit M7: only the BUYER's "won" creates the Order and counts as a closed deal. A seller's "won" is an advisory
 * claim: it is stored, emits DealClaimedBySeller (the buyer is prompted to confirm) and creates nothing, so a seller cannot
 * fabricate orders (and the escrow / credit / review flows hanging off them) against a buyer.
 */
export async function reportDeal(actor: Actor, matchId: string, outcome: "won" | "lost" | "pending", valuePaise?: number | null): Promise<{ advisory: boolean }> {
  if (!["won", "lost", "pending"].includes(outcome)) throw new DomainError("validation", "Invalid outcome", undefined, "enquiries.invalidOutcome");
  if (valuePaise != null && (!Number.isInteger(valuePaise) || valuePaise < 0)) throw new DomainError("validation", "Invalid deal value", undefined, "enquiries.invalidDealValue");
  const m = await prisma.match.findUnique({ where: { id: matchId }, include: { enquiry: { select: { buyerBusinessId: true } } } });
  const participant = m && (m.sellerBusinessId === actor.businessId || m.enquiry.buyerBusinessId === actor.businessId);
  if (!m || !participant) throw new DomainError("not_found", "Conversation not found");
  if (m.status !== "accepted") throw new DomainError("conflict", "Only accepted leads can be reported.");
  const isBuyer = m.enquiry.buyerBusinessId === actor.businessId;
  const advisory = outcome === "won" && !isBuyer;
  await prisma.$transaction(async (tx) => {
    await tx.dealReport.create({ data: { matchId, reportedByBusinessId: actor.businessId, outcome, valuePaise: valuePaise == null ? null : BigInt(valuePaise) } });
    if (advisory) {
      const convo = await tx.conversation.findUnique({ where: { matchId }, select: { id: true } });
      await emit(tx, "DealClaimedBySeller", { type: "match", id: matchId }, {
        matchId, sellerBusinessId: m.sellerBusinessId, buyerBusinessId: m.enquiry.buyerBusinessId, conversationId: convo?.id ?? null, ...(valuePaise != null ? { valuePaise } : {}),
      });
      return;
    }
    await emit(tx, "DealReportedOffPlatform", { type: "match", id: matchId }, {
      matchId, reportedByBusinessId: actor.businessId, outcome, ...(valuePaise != null ? { valuePaise } : {}),
    });
    // ADR-007: a buyer-confirmed "won" deal becomes an off-platform Order record (idempotent per match).
    if (outcome === "won") await recordOrderTx(tx, matchId, { totalPaise: valuePaise ?? null });
  });
  return { advisory };
}
