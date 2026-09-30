// Buyer comparison + counter assist (ADR-014). Guardrails: counters are PROPOSALS the buyer edits and sends explicitly (as a
// plain message through enquiry.sendMessage); buyer bounds are enforced server-side on the proposal AND on the final send.
import * as ai from "@cnote/ai";
import { DomainError, emit, rateLimit } from "@cnote/core";
import { prisma, type CounterProposal } from "@cnote/db";
import * as enquiry from "@cnote/enquiry";
import { z } from "zod";
import { buyerBoundsProblems, checkBuyerCounter, fallbackCounter, landedPerUnit, rankQuotes, type BuyerBoundsInput, type Landed } from "./bounds";
import { hasStructuredTerms, structuredComparisonTerms } from "./terms";
import { isQuoteAssistEnabled, isUuid, json, logAgentAction, num, type Actor } from "./common";

const requireEnabled = () => { if (!isQuoteAssistEnabled()) throw new DomainError("conflict", "Quote assist is not enabled."); };
const rs = (paise: number) => `Rs ${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

export interface BuyerBoundsView extends BuyerBoundsInput { enquiryId: string }

async function ownedEnquiry(actor: Actor, enquiryId: string) {
  const e = isUuid(enquiryId) ? await enquiry.getBuyerEnquiry(actor.businessId, enquiryId) : null;
  if (!e) throw new DomainError("not_found", "Requirement not found");
  return e;
}

export async function getBuyerBounds(actor: Actor, enquiryId: string): Promise<BuyerBoundsView> {
  const e = await ownedEnquiry(actor, enquiryId);
  const b = await prisma.buyerBounds.findUnique({ where: { enquiryId } });
  // the RFQ's own target price seeds the bound until the buyer sets one
  return { enquiryId, targetPricePaise: num(b?.targetPricePaise) ?? (b ? null : e.targetPricePaise), ceilingPricePaise: num(b?.ceilingPricePaise), maxLeadTimeDays: b?.maxLeadTimeDays ?? null };
}

export const buyerBoundsSchema = z.object({
  targetPricePaise: z.number().int().positive().max(10_000_000_000_00).nullable(),
  ceilingPricePaise: z.number().int().positive().max(10_000_000_000_00).nullable(),
  maxLeadTimeDays: z.number().int().min(1).max(365).nullable(),
});

export async function setBuyerBounds(actor: Actor, enquiryId: string, input: BuyerBoundsInput): Promise<BuyerBoundsView> {
  await ownedEnquiry(actor, enquiryId);
  const parsed = buyerBoundsSchema.safeParse(input);
  if (!parsed.success) throw new DomainError("validation", buyerBoundsProblems(input)[0] ?? parsed.error.issues[0]?.message ?? "Invalid bounds");
  const problems = buyerBoundsProblems(parsed.data);
  if (problems.length) throw new DomainError("validation", problems[0]!, problems);
  const data = {
    targetPricePaise: parsed.data.targetPricePaise == null ? null : BigInt(parsed.data.targetPricePaise),
    ceilingPricePaise: parsed.data.ceilingPricePaise == null ? null : BigInt(parsed.data.ceilingPricePaise), maxLeadTimeDays: parsed.data.maxLeadTimeDays,
  };
  await prisma.buyerBounds.upsert({ where: { enquiryId }, create: { enquiryId, buyerBusinessId: actor.businessId, ...data }, update: data });
  return { enquiryId, ...parsed.data };
}

// ---------------------------------------------------------------- comparison
export interface CounterProposalView {
  id: string;
  quoteId: string;
  status: "proposed" | "sent" | "discarded";
  quotedPricePaise: number;
  pricePaise: number;
  leadTimeDays: number | null;
  note: string;
  rationale: string;
  confidence: number;
  needsReview: boolean;
  edited: boolean;
  createdAt: string;
}

export interface ComparisonRow {
  quoteId: string;
  matchId: string;
  conversationId: string;
  sellerBusinessId: string;
  sellerName: string;
  verificationTier: number;
  badgeActive: boolean;
  trustScore: number;
  pricePaise: number;
  quantity: number;
  unit: string;
  leadTimeDays: number | null;
  validUntil: string | null;
  expired: boolean;
  notes: string | null;
  deliveryChargePaise: number | null;
  deliveryIncluded: boolean | null;
  gstPercent: number | null;
  gstIncluded: boolean | null;
  /** Free text for old quotes (read from the notes); for structured quotes this equals `paymentTermsCode`. */
  paymentTerms: string | null;
  /** Structured seller terms (enquiry.Quote); null on old quotes. */
  moq: number | null;
  moqUnit: string | null;
  deliveryTerms: enquiry.DeliveryTerms | null;
  deliveryNote: string | null;
  paymentTermsCode: enquiry.PaymentTerms | null;
  paymentNote: string | null;
  /** True when the terms above come from the seller's structured fields rather than the notes. */
  structured: boolean;
  landedPaise: number;
  landedComplete: boolean;
  assumptions: Landed["assumptions"];
  /** text badges (never colour alone): best_price | fastest | best_value */
  badges: ("best_price" | "fastest" | "best_value")[];
  earlierQuotes: number;
  counter: CounterProposalView | null;
}

export interface ComparisonView {
  enquiryId: string;
  quantity: number | null;
  unit: string | null;
  bounds: BuyerBoundsView;
  rows: ComparisonRow[];
  bestValueQuoteId: string | null;
  needsReview: boolean;
}

const toCounterView = (p: CounterProposal, needsReview = false): CounterProposalView => ({
  id: p.id, quoteId: p.quoteId, status: p.status, quotedPricePaise: Number(p.quotedPricePaise), pricePaise: Number(p.pricePaise), leadTimeDays: p.leadTimeDays, note: p.note,
  rationale: p.rationale, confidence: p.confidence, needsReview, edited: p.edited, createdAt: p.createdAt.toISOString(),
});

/**
 * Normalises the latest quote from each seller into like-for-like columns. Freight/GST terms are extracted once per quote
 * (logged AI decision) and stored; landed price per unit is plain arithmetic on top. Unknown terms are flagged, never guessed.
 */
export async function compareQuotes(actor: Actor, enquiryId: string): Promise<ComparisonView> {
  requireEnabled();
  const e = await ownedEnquiry(actor, enquiryId);
  const bounds = await getBuyerBounds(actor, enquiryId);
  type Q = { q: enquiry.ConversationView["quotes"][number]; m: (typeof e.matches)[number]; conversationId: string; earlier: number };
  const latest: Q[] = [];
  for (const m of e.matches.filter((x) => x.status === "accepted" && x.conversationId)) {
    const c = await enquiry.getConversation(actor, m.conversationId!);
    const quotes = c?.quotes ?? [];
    if (quotes.length) latest.push({ q: quotes[quotes.length - 1]!, m, conversationId: m.conversationId!, earlier: quotes.length - 1 });
  }
  const ids = latest.map((x) => x.q.id);
  let terms = new Map((await prisma.quoteTerms.findMany({ where: { quoteId: { in: ids } } })).map((t) => [t.quoteId, t]));
  let needsReview = false;
  const missing = latest.filter((x) => !hasStructuredTerms(x.q) && !terms.has(x.q.id)); // structured quotes need no extraction
  if (missing.length) {
    const out = await ai.normaliseQuotes(
      { quotes: missing.map((x) => ({ quoteId: x.q.id, pricePaise: x.q.pricePaise, quantity: x.q.quantity, unit: x.q.unit, notes: x.q.notes })) },
      { type: "quote_comparison", id: enquiryId },
    );
    needsReview = out.needsReview;
    await prisma.$transaction(async (tx) => {
      await tx.quoteTerms.createMany({
        skipDuplicates: true,
        data: out.terms.map((t) => ({
          quoteId: t.quoteId, enquiryId, deliveryChargePaise: t.deliveryChargePaise == null ? null : BigInt(t.deliveryChargePaise), deliveryIncluded: t.deliveryIncluded,
          gstPercent: t.gstPercent, gstIncluded: t.gstIncluded, paymentTerms: t.paymentTerms, confidence: out.confidence, aiDecisionId: out.decisionId,
        })),
      });
      await logAgentAction({
        principalBusinessId: actor.businessId, principalRole: "buyer", action: "quotes_normalised", subjectType: "enquiry", subjectId: enquiryId, enquiryId, aiDecisionId: out.decisionId,
        summary: `Read the freight, GST and payment terms in ${out.terms.length} quote${out.terms.length === 1 ? "" : "s"} so they can be compared like for like. Nothing was sent to any seller.`,
        details: { quoteIds: out.terms.map((t) => t.quoteId), confidence: out.confidence },
      }, tx);
    });
    terms = new Map((await prisma.quoteTerms.findMany({ where: { quoteId: { in: ids } } })).map((t) => [t.quoteId, t]));
  }
  const counters = await prisma.counterProposal.findMany({ where: { enquiryId, buyerBusinessId: actor.businessId, status: { in: ["proposed", "sent"] } }, orderBy: { createdAt: "desc" } });
  const today = new Date().toISOString().slice(0, 10);
  const rows: ComparisonRow[] = latest.map(({ q, m, conversationId, earlier }) => {
    const structured = hasStructuredTerms(q);
    const st = structured ? structuredComparisonTerms(q) : null;
    const t = structured ? null : terms.get(q.id);
    const charge = st ? st.deliveryChargePaise : num(t?.deliveryChargePaise);
    const deliveryIncluded = st ? st.deliveryIncluded : (t?.deliveryIncluded ?? null);
    const gstPercent = t?.gstPercent ?? null;
    const gstIncluded = st ? st.gstIncluded : (t?.gstIncluded ?? null);
    const landed = landedPerUnit({ pricePaise: q.pricePaise, quantity: q.quantity, deliveryChargePaise: charge, deliveryIncluded, gstPercent, gstIncluded });
    const c = counters.find((x) => x.quoteId === q.id);
    return {
      quoteId: q.id, matchId: m.id, conversationId, sellerBusinessId: m.sellerBusinessId, sellerName: m.sellerName, verificationTier: m.seller?.verificationTier ?? 0,
      badgeActive: m.seller?.badgeActive ?? false, trustScore: m.seller?.trustScore ?? 0, pricePaise: q.pricePaise, quantity: q.quantity, unit: q.unit, leadTimeDays: q.leadTimeDays,
      validUntil: q.validUntil, expired: !!q.validUntil && q.validUntil < today, notes: q.notes, deliveryChargePaise: charge, deliveryIncluded,
      gstPercent, gstIncluded, paymentTerms: st ? st.paymentTerms : (t?.paymentTerms ?? null),
      moq: q.moq, moqUnit: q.moqUnit, deliveryTerms: q.deliveryTerms, deliveryNote: q.deliveryNote, paymentTermsCode: q.paymentTerms, paymentNote: q.paymentNote, structured,
      landedPaise: landed.landedPaise, landedComplete: landed.complete,
      assumptions: landed.assumptions, badges: [], earlierQuotes: earlier, counter: c ? toCounterView(c) : null,
    };
  });
  const rank = rankQuotes(rows.map((r) => ({ key: r.quoteId, landedPaise: r.landedPaise, leadTimeDays: r.leadTimeDays, verificationTier: r.verificationTier, expired: r.expired })));
  for (const r of rows) {
    if (r.quoteId === rank.bestPrice) r.badges.push("best_price");
    if (r.quoteId === rank.fastest) r.badges.push("fastest");
    if (r.quoteId === rank.bestValue) r.badges.push("best_value");
  }
  rows.sort((a, b) => a.landedPaise - b.landedPaise);
  return { enquiryId, quantity: e.quantity, unit: e.quantityUnit, bounds, rows, bestValueQuoteId: rank.bestValue, needsReview };
}

// ---------------------------------------------------------------- counters
/** The exact message body sent to the seller: the buyer's (editable) note plus a server-built line so figures can never disagree with the price. */
export function composeCounterMessage(p: { note: string; quotedPricePaise: number; pricePaise: number; unit: string; leadTimeDays: number | null }): string {
  const line = `Counter-offer: ${rs(p.pricePaise)} per ${p.unit} (your quote: ${rs(p.quotedPricePaise)})${p.leadTimeDays != null ? `, delivery within ${p.leadTimeDays} days` : ""}.`;
  return [p.note.trim(), line].filter(Boolean).join("\n\n");
}

/**
 * Proposes ONE counter for a received quote, within the buyer's bounds. If the model's price is outside the bounds it is rejected
 * (logged) and a deterministic in-bounds counter is proposed instead. Nothing is sent; the buyer reviews and sends it.
 */
export async function proposeCounterOffer(actor: Actor, enquiryId: string, quoteId: string): Promise<CounterProposalView> {
  requireEnabled();
  if (!(await rateLimit(`negotiation:counter:${actor.personId}`, 30, 3600))) throw new DomainError("rate_limited", "Too many counter requests. Try again later.");
  const cmp = await compareQuotes(actor, enquiryId);
  const row = cmp.rows.find((r) => r.quoteId === quoteId);
  if (!row) throw new DomainError("not_found", "Quote not found");
  const b = cmp.bounds;
  if (b.targetPricePaise == null && b.ceilingPricePaise == null && b.maxLeadTimeDays == null) throw new DomainError("validation", "Set a target price, a maximum price or a delivery limit first.");
  if (b.targetPricePaise != null && row.pricePaise <= b.targetPricePaise) throw new DomainError("conflict", "This quote is already at or below your target price. No counter needed.");
  const others = cmp.rows.filter((r) => r.quoteId !== quoteId);
  const proposalId = crypto.randomUUID();
  const out = await ai.proposeCounter({
    enquiryTitle: (await ownedEnquiry(actor, enquiryId)).title,
    quote: { pricePaise: row.pricePaise, quantity: row.quantity, unit: row.unit, leadTimeDays: row.leadTimeDays }, bounds: { ...b, targetPricePaise: b.targetPricePaise, ceilingPricePaise: b.ceilingPricePaise, maxLeadTimeDays: b.maxLeadTimeDays },
    peers: { count: cmp.rows.length, bestLandedPricePaise: others.length ? Math.min(...others.map((r) => r.landedPaise)) : null, thisLandedPricePaise: row.landedPaise },
  }, { type: "counter_proposal", id: proposalId });

  let final = { pricePaise: out.pricePaise, leadTimeDays: out.leadTimeDays };
  const check = checkBuyerCounter(final, { pricePaise: row.pricePaise }, b);
  let rejected: { pricePaise: number; leadTimeDays: number | null; violations: string[] } | null = null;
  if (!check.ok) {
    rejected = { pricePaise: out.pricePaise, leadTimeDays: out.leadTimeDays, violations: check.violations };
    const fb = fallbackCounter({ pricePaise: row.pricePaise, leadTimeDays: row.leadTimeDays }, b);
    if (!fb || !checkBuyerCounter(fb, { pricePaise: row.pricePaise }, b).ok) {
      await logAgentAction({
        principalBusinessId: actor.businessId, principalRole: "buyer", action: "counter_bounds_rejected", subjectType: "quote", subjectId: quoteId, enquiryId, aiDecisionId: out.decisionId,
        summary: "The assistant's counter was outside your limits and no valid counter exists for this quote, so nothing was proposed.", details: { ...rejected },
      });
      throw new DomainError("conflict", "No counter fits your limits for this quote. Adjust your maximum price or negotiate by message.");
    }
    final = fb;
  }
  const note = out.note.trim().slice(0, 1000) || "Thank you for your quote. Could you please review the price below?";
  const row2 = await prisma.$transaction(async (tx) => {
    await tx.counterProposal.updateMany({ where: { quoteId, buyerBusinessId: actor.businessId, status: "proposed" }, data: { status: "discarded" } });
    const p = await tx.counterProposal.create({
      data: {
        id: proposalId, enquiryId, quoteId, conversationId: row.conversationId, buyerBusinessId: actor.businessId, sellerBusinessId: row.sellerBusinessId, quotedPricePaise: BigInt(row.pricePaise),
        pricePaise: BigInt(final.pricePaise), leadTimeDays: final.leadTimeDays, note, rationale: rejected ? `${out.rationale} (The first suggestion was outside your limits, so the closest allowed counter is shown.)` : out.rationale,
        confidence: out.confidence, boundsSnapshot: json({ ...b, rejected }), aiDecisionId: out.decisionId,
      },
    });
    if (rejected) {
      await logAgentAction({
        principalBusinessId: actor.businessId, principalRole: "buyer", action: "counter_bounds_rejected", subjectType: "counter_proposal", subjectId: p.id, enquiryId, aiDecisionId: out.decisionId,
        summary: "The assistant's first counter was outside your limits, so it was discarded and a counter within your limits is proposed instead.", details: { ...rejected },
      }, tx);
    }
    await logAgentAction({
      principalBusinessId: actor.businessId, principalRole: "buyer", action: "counter_proposed", subjectType: "counter_proposal", subjectId: p.id, enquiryId, aiDecisionId: out.decisionId,
      summary: `Proposed a counter of ${rs(final.pricePaise)} per ${row.unit} to ${row.sellerName} (quoted ${rs(row.pricePaise)}). Nothing was sent. You decide whether to send it.`,
      details: { quoteId, pricePaise: final.pricePaise, quotedPricePaise: row.pricePaise, confidence: out.confidence },
    }, tx);
    return p;
  });
  return toCounterView(row2, out.needsReview);
}

export const counterEditsSchema = z.object({
  pricePaise: z.number().int().positive().max(10_000_000_000_00).optional(),
  leadTimeDays: z.number().int().min(1).max(730).nullable().optional(),
  note: z.string().trim().max(1000).optional(),
});
export type CounterEdits = z.input<typeof counterEditsSchema>;

async function loadCounter(actor: Actor, id: string): Promise<CounterProposal> {
  const p = isUuid(id) ? await prisma.counterProposal.findUnique({ where: { id } }) : null;
  if (!p || p.buyerBusinessId !== actor.businessId) throw new DomainError("not_found", "Counter not found");
  return p;
}

export async function getCounterProposal(actor: Actor, id: string): Promise<CounterProposalView | null> {
  try { return toCounterView(await loadCounter(actor, id)); } catch { return null; }
}

/**
 * Sends the buyer's counter as a chat message. The price is re-checked against the buyer's CURRENT bounds and the quoted price;
 * nothing is sent unless the buyer calls this. Emits CounterOfferProposed.
 */
export async function sendCounterOffer(actor: Actor, proposalId: string, edits: CounterEdits = {}): Promise<CounterProposalView> {
  const p = await loadCounter(actor, proposalId);
  if (p.status === "sent") return toCounterView(p);
  if (p.status !== "proposed") throw new DomainError("conflict", "This counter was discarded.");
  const parsed = counterEditsSchema.safeParse(edits);
  if (!parsed.success) throw new DomainError("validation", parsed.error.issues[0]?.message ?? "Invalid counter");
  const e = parsed.data;
  const pricePaise = e.pricePaise ?? Number(p.pricePaise);
  const leadTimeDays = e.leadTimeDays !== undefined ? e.leadTimeDays : p.leadTimeDays;
  const note = e.note !== undefined ? e.note : p.note;
  const bounds = await getBuyerBounds(actor, p.enquiryId);
  const check = checkBuyerCounter({ pricePaise, leadTimeDays }, { pricePaise: Number(p.quotedPricePaise) }, bounds);
  if (!check.ok) throw new DomainError("validation", check.violations[0]!, check.violations);
  const edited = pricePaise !== Number(p.pricePaise) || leadTimeDays !== p.leadTimeDays || note.trim() !== p.note.trim();

  const claim = await prisma.counterProposal.updateMany({ where: { id: p.id, status: "proposed" }, data: { status: "sent", sentByPersonId: actor.personId, sentAt: new Date() } });
  if (claim.count === 0) throw new DomainError("conflict", "This counter was already handled.");
  const unit = (await enquiry.getQuote(actor, p.quoteId))?.unit ?? "unit";
  try {
    await enquiry.sendMessage(actor, p.conversationId, composeCounterMessage({ note, quotedPricePaise: Number(p.quotedPricePaise), pricePaise, unit, leadTimeDays }));
  } catch (err) {
    await prisma.counterProposal.updateMany({ where: { id: p.id, status: "sent" }, data: { status: "proposed", sentByPersonId: null, sentAt: null } });
    throw err;
  }
  const row = await prisma.$transaction(async (tx) => {
    const u = await tx.counterProposal.update({ where: { id: p.id }, data: { pricePaise: BigInt(pricePaise), leadTimeDays, note: note.trim(), edited } });
    await emit(tx, "CounterOfferProposed", { type: "enquiry", id: p.enquiryId }, { proposalId: p.id, enquiryId: p.enquiryId, quoteId: p.quoteId, buyerBusinessId: actor.businessId, pricePaise });
    await logAgentAction({
      principalBusinessId: actor.businessId, principalRole: "buyer", action: "counter_sent", subjectType: "counter_proposal", subjectId: p.id, enquiryId: p.enquiryId, actorPersonId: actor.personId,
      aiDecisionId: p.aiDecisionId, summary: `You sent the counter${edited ? " (edited)" : ""} of ${rs(pricePaise)} per ${unit} to the seller.`, details: { edited, pricePaise, quotedPricePaise: Number(p.quotedPricePaise), leadTimeDays },
    }, tx);
    return u;
  });
  return toCounterView(row);
}

export async function discardCounterOffer(actor: Actor, proposalId: string): Promise<void> {
  const p = await loadCounter(actor, proposalId);
  if (p.status === "discarded") return;
  if (p.status === "sent") throw new DomainError("conflict", "This counter was already sent.");
  const claim = await prisma.counterProposal.updateMany({ where: { id: p.id, status: "proposed" }, data: { status: "discarded" } });
  if (claim.count === 0) return;
  await logAgentAction({
    principalBusinessId: actor.businessId, principalRole: "buyer", action: "counter_discarded", subjectType: "counter_proposal", subjectId: p.id, enquiryId: p.enquiryId, actorPersonId: actor.personId,
    aiDecisionId: p.aiDecisionId, summary: "You discarded the proposed counter. Nothing was sent.",
  });
}

