// Seller quote-assist (ADR-014). Guardrails: the agent only DRAFTS; a draft becomes a real Quote solely when the seller
// approves (enquiry.sendQuote as the seller); the floor is enforced server-side on generation AND on approval.
import * as ai from "@cnote/ai";
import { DomainError, emit, rateLimit } from "@cnote/core";
import { prisma, type QuoteDraft } from "@cnote/db";
import * as enquiry from "@cnote/enquiry";
import * as identity from "@cnote/identity";
import { z } from "zod";
import { checkSellerQuote, editStats, type DraftFields } from "./bounds";
import { NIL_UUID, dateOnly, isQuoteAssistEnabled, isUuid, json, logAgentAction, type Actor } from "./common";
import { mapShippingTerms } from "./terms";
import { getPriceBookEntry, selectPriceBookForRfq } from "./pricebook";

export interface QuoteDraftView {
  id: string;
  matchId: string;
  conversationId: string;
  status: "pending" | "approved" | "discarded";
  pricePaise: number;
  quantity: number;
  unit: string;
  moq: number | null;
  leadTimeDays: number | null;
  shippingTerms: string | null;
  validUntil: string | null;
  notes: string | null;
  rationale: string;
  confidence: number;
  needsReview: boolean;
  boundsCheck: { ok: boolean; floorPaise: number | null; modelPriceRejected: boolean; violations: string[] };
  edited: boolean;
  quoteId: string | null;
  createdAt: string;
}

export const toDraftView = (d: QuoteDraft): QuoteDraftView => {
  const b = (d.boundsCheck ?? {}) as Partial<QuoteDraftView["boundsCheck"]>;
  return {
    id: d.id, matchId: d.matchId, conversationId: d.conversationId, status: d.status, pricePaise: Number(d.pricePaise), quantity: d.quantity, unit: d.unit, moq: d.moq,
    leadTimeDays: d.leadTimeDays, shippingTerms: d.shippingTerms, validUntil: dateOnly(d.validUntil), notes: d.notes, rationale: d.rationale, confidence: d.confidence,
    needsReview: d.needsReview, boundsCheck: { ok: b.ok ?? true, floorPaise: b.floorPaise ?? null, modelPriceRejected: b.modelPriceRejected ?? false, violations: b.violations ?? [] },
    edited: d.edited, quoteId: d.quoteId, createdAt: d.createdAt.toISOString(),
  };
};

const addDays = (from: Date, days: number) => new Date(from.getTime() + days * 86_400_000).toISOString().slice(0, 10);

/** The seller's recent quotes through enquiry's public reads (auxiliary context: failures degrade to "no history"). */
async function quoteHistory(sellerBusinessId: string): Promise<ai.DraftQuoteInput["history"]> {
  try {
    const { items } = await enquiry.listSellerQuotes({ personId: NIL_UUID, businessId: sellerBusinessId }, { limit: 10 });
    return { quotesSent: items.length, recent: items.map((q) => ({ pricePaise: q.pricePaise, quantity: q.quantity, unit: q.unit, leadTimeDays: q.leadTimeDays })) };
  } catch {
    return { quotesSent: 0, recent: [] };
  }
}

/**
 * Drafts a quote for an accepted lead. Idempotent per match. Returns null (and logs why) when there is no price book entry to
 * price from. The model's price is REJECTED if it breaks the seller's floor / lead-time bounds; the deterministic tier price is used.
 */
export async function generateDraft(sellerBusinessId: string, matchId: string): Promise<QuoteDraftView | null> {
  if (!isUuid(matchId)) throw new DomainError("not_found", "Lead not found");
  const existing = await prisma.quoteDraft.findUnique({ where: { matchId } });
  if (existing) return toDraftView(existing);
  const lead = await enquiry.getSellerLead(sellerBusinessId, matchId);
  if (!lead) throw new DomainError("not_found", "Lead not found");
  if (lead.status !== "accepted" || !lead.conversationId) throw new DomainError("conflict", "Accept the lead before drafting a quote.");
  const e = lead.enquiry;
  const now = new Date();
  const draftId = crypto.randomUUID();

  const book = await selectPriceBookForRfq(sellerBusinessId, { title: e.title, requirement: e.requirement, categorySlug: e.category?.slug ?? null });
  if (!book) {
    await logAgentAction({
      principalBusinessId: sellerBusinessId, principalRole: "seller", action: "draft_failed", subjectType: "match", subjectId: matchId, enquiryId: e.id,
      summary: "Could not draft a quote: no active price book entry matches this requirement. Add one under Price book or quote manually.",
    });
    return null;
  }
  const history = await quoteHistory(sellerBusinessId);
  const out = await ai.draftQuote({
    rfq: { title: e.title, requirement: e.requirement, quantity: e.quantity, unit: e.quantityUnit, targetPricePaise: e.targetPricePaise, neededBy: e.neededBy, deliveryCity: e.deliveryCity, deliveryPincode: e.deliveryPincode },
    priceBook: {
      basePricePaise: book.basePricePaise, unit: book.unit, tiers: book.tiers, floorPricePaise: book.floorPricePaise, moq: book.moq, leadTimeDays: book.leadTimeDays,
      deliveryTerms: book.deliveryTerms, gstPercent: book.gstPercent, gstIncluded: book.gstIncluded, validityDays: book.validityDays,
    },
    history, today: now.toISOString().slice(0, 10),
  }, { type: "quote_draft", id: draftId });

  // ---- server-side bounds: the model output is a suggestion, never an authority
  const proposed = { pricePaise: out.pricePaise, quantity: out.quantity, leadTimeDays: out.leadTimeDays };
  const check = checkSellerQuote(proposed, { floorPricePaise: book.floorPricePaise, minLeadTimeDays: book.leadTimeDays });
  const safe = {
    pricePaise: Math.max(out.pricePaise ?? 0, book.floorPricePaise),
    leadTimeDays: Math.max(out.leadTimeDays ?? book.leadTimeDays, book.leadTimeDays),
  };
  let pricePaise = out.pricePaise as number;
  let leadTimeDays = out.leadTimeDays;
  if (!check.ok) {
    pricePaise = out.pricePaise != null && out.pricePaise >= book.floorPricePaise ? out.pricePaise : Math.max(ai.tierPriceFor(book.basePricePaise, book.tiers, Math.max(1, out.quantity)), book.floorPricePaise);
    leadTimeDays = safe.leadTimeDays;
  }
  const quantity = Math.max(1, out.quantity, book.moq ?? 1);
  const fields: DraftFields = {
    pricePaise, quantity, unit: out.unit, leadTimeDays, shippingTerms: out.shippingTerms, validUntil: addDays(now, Math.max(1, out.validityDays)), notes: out.notes || null,
  };
  const boundsCheck = { ok: true, floorPaise: book.floorPricePaise, modelPriceRejected: !check.ok, violations: check.violations, ...(check.ok ? {} : { rejectedModelPricePaise: out.pricePaise }) };

  try {
    const row = await prisma.$transaction(async (tx) => {
      const d = await tx.quoteDraft.create({
        data: {
          id: draftId, matchId, enquiryId: e.id, conversationId: lead.conversationId!, sellerBusinessId, priceBookId: book.id, pricePaise: BigInt(fields.pricePaise), quantity: fields.quantity,
          unit: fields.unit, moq: out.moq, leadTimeDays: fields.leadTimeDays, shippingTerms: fields.shippingTerms, validUntil: new Date(fields.validUntil!), notes: fields.notes,
          rationale: out.rationale, confidence: out.confidence, needsReview: out.needsReview || !check.ok, boundsCheck: json(boundsCheck), original: json(fields), aiDecisionId: out.decisionId,
        },
      });
      await emit(tx, "QuoteDraftGenerated", { type: "match", id: matchId }, { draftId, matchId, sellerBusinessId, pricePaise: fields.pricePaise, confidence: out.confidence });
      await logAgentAction({
        principalBusinessId: sellerBusinessId, principalRole: "seller", action: "draft_generated", subjectType: "quote_draft", subjectId: draftId, enquiryId: e.id, aiDecisionId: out.decisionId,
        summary: `Drafted a quote at Rs ${(fields.pricePaise / 100).toFixed(2)} per ${fields.unit} for ${fields.quantity} ${fields.unit}. Nothing was sent to the buyer.`,
        details: { pricePaise: fields.pricePaise, confidence: out.confidence, rationale: out.rationale, priceBookId: book.id },
      }, tx);
      if (!check.ok) {
        await logAgentAction({
          principalBusinessId: sellerBusinessId, principalRole: "seller", action: "draft_bounds_rejected", subjectType: "quote_draft", subjectId: draftId, enquiryId: e.id, aiDecisionId: out.decisionId,
          summary: "The assistant's first price broke your price book limits, so it was discarded and your price book price was used instead.",
          details: { rejectedPricePaise: out.pricePaise, violations: check.violations },
        }, tx);
      }
      return d;
    });
    return toDraftView(row);
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return toDraftView((await prisma.quoteDraft.findUniqueOrThrow({ where: { matchId } })));
    throw err;
  }
}

/** Seller asks for a draft on demand (leads accepted before the flag was on, or the job hasn't run yet). */
export async function requestDraft(actor: Actor, matchId: string): Promise<QuoteDraftView | null> {
  if (!isQuoteAssistEnabled()) throw new DomainError("conflict", "Quote assist is not enabled.");
  if (!(await rateLimit(`negotiation:draft:${actor.personId}`, 30, 3600))) throw new DomainError("rate_limited", "Too many draft requests. Try again later.");
  return generateDraft(actor.businessId, matchId);
}

export async function getDraftForMatch(sellerBusinessId: string, matchId: string): Promise<QuoteDraftView | null> {
  if (!isUuid(matchId)) return null;
  const d = await prisma.quoteDraft.findFirst({ where: { matchId, sellerBusinessId } });
  return d ? toDraftView(d) : null;
}

export const draftEditsSchema = z.object({
  pricePaise: z.number().int().positive().max(10_000_000_000_00).optional(),
  quantity: z.number().int().positive().max(2_000_000_000).optional(),
  unit: z.string().trim().min(1).max(20).optional(),
  leadTimeDays: z.number().int().min(0).max(730).nullable().optional(),
  shippingTerms: z.string().trim().max(300).nullable().optional(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});
export type DraftEdits = z.input<typeof draftEditsSchema>;

async function loadOwned(actor: Actor, draftId: string): Promise<QuoteDraft> {
  const d = isUuid(draftId) ? await prisma.quoteDraft.findUnique({ where: { id: draftId } }) : null;
  if (!d || d.sellerBusinessId !== actor.businessId) throw new DomainError("not_found", "Draft not found");
  return d;
}

/**
 * The ONLY path from a draft to a real quote: the seller confirms (optionally with edits). Bounds are re-checked against the
 * CURRENT price book floor; then enquiry.sendQuote runs as the seller. `via` records where the confirmation came from.
 */
export async function approveDraft(actor: Actor, draftId: string, edits: DraftEdits = {}, via: "app" | "whatsapp" = "app"): Promise<QuoteDraftView> {
  const d = await loadOwned(actor, draftId);
  if (d.status === "approved" && d.quoteId) return toDraftView(d);
  if (d.status !== "pending") throw new DomainError("conflict", d.status === "approved" ? "This draft is already being sent." : "This draft was discarded.");
  const parsed = draftEditsSchema.safeParse(edits);
  if (!parsed.success) throw new DomainError("validation", parsed.error.issues[0]?.message ?? "Invalid edit");
  const e = parsed.data;
  const original = d.original as unknown as DraftFields;
  const final: DraftFields = {
    pricePaise: e.pricePaise ?? Number(d.pricePaise), quantity: e.quantity ?? d.quantity, unit: e.unit ?? d.unit,
    leadTimeDays: e.leadTimeDays !== undefined ? e.leadTimeDays : d.leadTimeDays, shippingTerms: e.shippingTerms !== undefined ? e.shippingTerms : d.shippingTerms,
    validUntil: e.validUntil !== undefined ? e.validUntil : dateOnly(d.validUntil), notes: e.notes !== undefined ? e.notes : d.notes,
  };
  const book = d.priceBookId ? await getPriceBookEntry(actor.businessId, d.priceBookId) : null;
  const floor = book?.floorPricePaise ?? ((d.boundsCheck as { floorPaise?: number | null }).floorPaise ?? null);
  if (floor != null) {
    const c = checkSellerQuote({ pricePaise: final.pricePaise, quantity: final.quantity }, { floorPricePaise: floor });
    if (!c.ok) throw new DomainError("validation", `${c.violations[0]} Lower your floor in the price book first if you really want this price.`, c.violations);
  }
  const stats = editStats(original, final);
  const edited = stats.editedFields > 0;

  // claim the draft so a double tap / retry can never send two quotes
  const claim = await prisma.quoteDraft.updateMany({ where: { id: d.id, status: "pending" }, data: { status: "approved", decidedByPersonId: actor.personId, decidedVia: via, decidedAt: new Date() } });
  if (claim.count === 0) throw new DomainError("conflict", "This draft was already handled.");

  // ADR-014 follow-up: shipping/MOQ/GST go into the structured quote fields, not folded into the notes.
  const shipping = mapShippingTerms(final.shippingTerms);
  let quoteId: string;
  try {
    ({ quoteId } = await enquiry.sendQuote(actor, d.conversationId, {
      pricePaise: final.pricePaise, quantity: final.quantity, unit: final.unit, leadTimeDays: final.leadTimeDays, notes: final.notes,
      validUntil: final.validUntil ? new Date(`${final.validUntil}T23:59:59+05:30`).toISOString() : null,
      moq: d.moq, moqUnit: d.moq != null ? final.unit : null, deliveryTerms: shipping.deliveryTerms, deliveryNote: shipping.deliveryNote,
      gstIncluded: book ? book.gstIncluded : null,
    }));
  } catch (err) {
    await prisma.quoteDraft.updateMany({ where: { id: d.id, status: "approved", quoteId: null }, data: { status: "pending", decidedByPersonId: null, decidedVia: null, decidedAt: null } });
    throw err;
  }

  const row = await prisma.$transaction(async (tx) => {
    const u = await tx.quoteDraft.update({
      where: { id: d.id },
      data: {
        quoteId, edited, editedFields: stats.editedFields, priceDeltaPct: stats.priceDeltaPct, notesEditDistance: stats.notesEditDistance,
        pricePaise: BigInt(final.pricePaise), quantity: final.quantity, unit: final.unit, leadTimeDays: final.leadTimeDays, shippingTerms: final.shippingTerms,
        validUntil: final.validUntil ? new Date(final.validUntil) : null, notes: final.notes,
      },
    });
    await emit(tx, "QuoteDraftApproved", { type: "match", id: d.matchId }, { draftId: d.id, matchId: d.matchId, quoteId, sellerBusinessId: actor.businessId, edited });
    await tx.leadQuoteTiming.updateMany({ where: { conversationId: d.conversationId, assisted: false, firstQuoteAt: null }, data: { assisted: true } });
    await logAgentAction({
      principalBusinessId: actor.businessId, principalRole: "seller", action: "draft_approved", subjectType: "quote_draft", subjectId: d.id, enquiryId: d.enquiryId,
      actorPersonId: actor.personId, aiDecisionId: d.aiDecisionId,
      summary: `You approved the draft${edited ? " with edits" : ""} (${via === "whatsapp" ? "WhatsApp" : "app"}). The quote was sent to the buyer at Rs ${(final.pricePaise / 100).toFixed(2)} per ${final.unit}.`,
      details: { edited, ...stats, quoteId, via },
    }, tx);
    return u;
  });
  return toDraftView(row);
}

export async function discardDraft(actor: Actor, draftId: string, via: "app" | "whatsapp" = "app"): Promise<QuoteDraftView> {
  const d = await loadOwned(actor, draftId);
  if (d.status === "discarded") return toDraftView(d);
  if (d.status !== "pending") throw new DomainError("conflict", "This draft was already sent.");
  const claim = await prisma.quoteDraft.updateMany({ where: { id: d.id, status: "pending" }, data: { status: "discarded", decidedByPersonId: actor.personId, decidedVia: via, decidedAt: new Date() } });
  if (claim.count === 0) throw new DomainError("conflict", "This draft was already handled.");
  await logAgentAction({
    principalBusinessId: actor.businessId, principalRole: "seller", action: "draft_discarded", subjectType: "quote_draft", subjectId: d.id, enquiryId: d.enquiryId, actorPersonId: actor.personId,
    aiDecisionId: d.aiDecisionId, summary: "You discarded the draft. Nothing was sent to the buyer.", details: { via },
  });
  return toDraftView(await prisma.quoteDraft.findUniqueOrThrow({ where: { id: d.id } }));
}

/**
 * WhatsApp/other-channel confirmation hook (for @cnote/whatsapp). The person must belong to the drafting business.
 * "approve" sends the draft exactly as drafted (no edits over a chat button); "discard" drops it.
 */
export async function approveDraftFromChannel(
  draftId: string, sellerPersonId: string, decision: "approve" | "discard",
): Promise<{ status: "approved" | "discarded"; quoteId: string | null }> {
  const d = isUuid(draftId) ? await prisma.quoteDraft.findUnique({ where: { id: draftId } }) : null;
  if (!d) throw new DomainError("not_found", "Draft not found");
  if (!isUuid(sellerPersonId) || !(await identity.isBusinessMember(sellerPersonId, d.sellerBusinessId))) throw new DomainError("forbidden", "You cannot act on this draft.");
  const actor = { personId: sellerPersonId, businessId: d.sellerBusinessId };
  const v = decision === "approve" ? await approveDraft(actor, draftId, {}, "whatsapp") : await discardDraft(actor, draftId, "whatsapp");
  return { status: v.status === "approved" ? "approved" : "discarded", quoteId: v.quoteId };
}

