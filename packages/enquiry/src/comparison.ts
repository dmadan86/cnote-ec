// Buyer-side quote comparison and the "My requirements" board status (ADR-002 transparency, ADR-007 lifecycle).
import { getSubjectStatuses, recordSpend } from "@cnote/approvals";
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { assertCan, consult } from "./approvals";
import { quoteAttachments, type AttachmentView } from "./attachments";
import { reportDeal } from "./messaging";
import { applyLineAwards } from "./awards";
import { linesByEnquiry, lowestPerLine, type EnquiryLineView } from "./lines";
import { getQuote, toQuoteViewsWithLines, type QuoteView } from "./quotes";
import { profiles } from "./support";
import type { Actor, EnquiryView } from "./types";

export type BoardStatus = "open" | "quoted" | "closed" | "expired";
export const BOARD_STATUSES: readonly BoardStatus[] = ["open", "quoted", "closed", "expired"];

/**
 * Where a requirement sits on the buyer's board. Closed/rejected wins; then the quote deadline (`expiresAt`, derived,
 * so no sweep job can leave a stale status); then whether any seller has quoted yet.
 */
export function boardStatus(e: Pick<EnquiryView, "status" | "expiresAt" | "quoteCount">, now: Date = new Date()): BoardStatus {
  if (e.status === "closed" || e.status === "rejected") return "closed";
  if (e.expiresAt && new Date(e.expiresAt).getTime() <= now.getTime()) return "expired";
  return (e.quoteCount ?? 0) > 0 ? "quoted" : "open";
}

/** Per-status counts for the filter chips. */
export function boardCounts(list: Pick<EnquiryView, "status" | "expiresAt" | "quoteCount">[], now: Date = new Date()): Record<BoardStatus, number> {
  const out: Record<BoardStatus, number> = { open: 0, quoted: 0, closed: 0, expired: 0 };
  for (const e of list) out[boardStatus(e, now)]++;
  return out;
}

export interface ComparisonRow {
  matchId: string;
  conversationId: string;
  sellerBusinessId: string;
  sellerName: string;
  verificationTier: number;
  badgeActive: boolean;
  trustScore: number;
  rank: number;
  /** N: the lead cap this requirement was offered under. */
  of: number;
  quote: QuoteView & { attachments: AttachmentView[]; shortlisted: boolean };
  /** unit price x requested quantity (the quote's own quantity when the buyer gave none). Excludes delivery charge. */
  totalPaise: number;
  /** Which quantity `totalPaise` was computed for. "lines" = the sum of the supplier's per-line totals (GST per line), see `quote.lines`. */
  quantityBasis: "requested" | "quoted" | "lines";
  /** Per-line coverage of a multi-line quote: priced lines of the requirement's lines (null on single-field quotes). */
  coverage: { quoted: number; of: number } | null;
  quantity: number;
  /** Latest off-platform deal report on this match: "won" = accepted, "lost" = declined. */
  decision: "won" | "lost" | "pending" | null;
  /** Earlier quotes this seller replaced (only the latest is compared). */
  earlierQuotes: number;
  /** Approval status of accepting this quote (docs/design/buyer-approvals.md); null when no approval was ever asked. */
  approval: { status: "pending" | "approved" | "rejected" | "cancelled" | "expired"; requestId: string } | null;
}

export interface QuoteComparison {
  enquiryId: string;
  quantity: number | null;
  quantityUnit: string | null;
  /** N: suppliers the requirement was sent to (every match ever offered, incl. declined/expired). ADR-002. */
  sentTo: number;
  /** M: suppliers whose quotes are shown. */
  quotesFrom: number;
  expiresAt: string | null;
  rows: ComparisonRow[];
  /** The requirement's lines (rows of the line-by-line matrix), always at least one. */
  lines: EnquiryLineView[];
  /** quoteIds with the lowest payable per requirement line (ties all listed); only lines someone priced appear. */
  lowestByLine: Record<string, string[]>;
  /** Lines already awarded, so the matrix can show who got what. */
  awards: { enquiryLineId: string; quoteId: string; sellerBusinessId: string; orderId: string | null }[];
}

/** All quotes on one of the actor's requirements, latest per supplier, with trust signals. Null if not the buyer's. */
export async function getQuoteComparison(actor: Actor, enquiryId: string): Promise<QuoteComparison | null> {
  if (!/^[0-9a-f-]{36}$/i.test(enquiryId)) return null;
  const enq = await prisma.enquiry.findFirst({
    where: { id: enquiryId, buyerBusinessId: actor.businessId },
    include: { matches: { include: { conversation: { include: { quotes: { orderBy: { createdAt: "asc" } } } }, dealReports: { orderBy: { createdAt: "desc" }, take: 20 } } } },
  });
  if (!enq) return null;
  const withQuotes = enq.matches.filter((m) => (m.conversation?.quotes.length ?? 0) > 0);
  const latestQuotes = withQuotes.map((m) => m.conversation!.quotes[m.conversation!.quotes.length - 1]!);
  const [profs, files, quoteViews, lineMap, awardRows] = await Promise.all([
    profiles(withQuotes.map((m) => m.sellerBusinessId)),
    quoteAttachments(withQuotes.flatMap((m) => m.conversation!.quotes.map((q) => q.id))),
    toQuoteViewsWithLines(latestQuotes),
    linesByEnquiry([enquiryId]),
    prisma.enquiryLineAward.findMany({ where: { enquiryId } }),
  ]);
  const viewById = new Map(quoteViews.map((v) => [v.id, v]));
  const lines = lineMap.get(enquiryId) ?? [];
  const rows: ComparisonRow[] = withQuotes
    .map((m) => {
      const quotes = m.conversation!.quotes;
      const latest = quotes[quotes.length - 1]!;
      const p = profs.get(m.sellerBusinessId);
      const view = viewById.get(latest.id)!;
      const requested = enq.quantity ?? null;
      const quantity = requested ?? latest.quantity;
      const lineTotals = view.lineTotals;
      return {
        matchId: m.id,
        conversationId: m.conversation!.id,
        sellerBusinessId: m.sellerBusinessId,
        sellerName: p?.name ?? "Seller",
        verificationTier: p?.verificationTier ?? 0,
        badgeActive: p?.badgeActive ?? false,
        trustScore: p?.trustScore ?? 0,
        rank: m.rank,
        of: enq.sellerCap,
        quote: { ...view, attachments: files.get(latest.id) ?? [], shortlisted: latest.shortlistedAt !== null },
        totalPaise: lineTotals ? lineTotals.totalPaise : Number(latest.pricePaise) * quantity,
        quantityBasis: lineTotals ? ("lines" as const) : requested === null ? ("quoted" as const) : ("requested" as const),
        coverage: lineTotals ? { quoted: lineTotals.quotedLineCount, of: lines.length } : null,
        quantity,
        // a seller-reported "won" is an unconfirmed claim, never the buyer's decision (security audit M7)
        decision: m.dealReports.find((r) => !(r.outcome === "won" && r.reportedByBusinessId === m.sellerBusinessId))?.outcome ?? null,
        earlierQuotes: quotes.length - 1,
        approval: null,
      };
    })
    .sort((a, b) => a.rank - b.rank);
  const approvalOf = await getSubjectStatuses(actor.businessId, "quote", rows.map((r) => r.quote.id));
  for (const r of rows) r.approval = approvalOf.get(r.quote.id) ?? null;
  return {
    enquiryId: enq.id,
    quantity: enq.quantity,
    quantityUnit: enq.quantityUnit,
    sentTo: enq.matches.length,
    quotesFrom: rows.length,
    expiresAt: enq.expiresAt ? enq.expiresAt.toISOString() : null,
    rows,
    lines,
    lowestByLine: Object.fromEntries(
      [...lowestPerLine(rows.map((r) => ({ quoteId: r.quote.id, lines: r.quote.lines ?? [] })), lines.map((l) => l.id))].filter(([, w]) => w.size > 0).map(([id, w]) => [id, [...w]]),
    ),
    awards: awardRows.map((a) => ({ enquiryLineId: a.enquiryLineId, quoteId: a.quoteId, sellerBusinessId: a.sellerBusinessId, orderId: a.orderId })),
  };
}

/** Buyer-only shortlist flag on a quote. Idempotent; a seller (or anyone else) cannot set or see it. */
export async function setQuoteShortlisted(actor: Actor, quoteId: string, shortlisted: boolean): Promise<void> {
  const q = await getQuote(actor, quoteId);
  if (!q || q.role !== "buyer") throw new DomainError("not_found", "Quote not found");
  await prisma.quote.update({ where: { id: quoteId }, data: { shortlistedAt: shortlisted ? new Date() : null } });
}

/**
 * Buyer accepts or declines a quote. Phase-1 deals close off-platform, so this records the existing off-platform deal
 * report (ADR-007): accept = "won" at the quote's total for the requested quantity (an Order record is created),
 * decline = "lost". The value is computed here from the stored quote, never taken from the client.
 */
export async function decideQuote(actor: Actor, quoteId: string, decision: "accept" | "decline"): Promise<DecideQuoteResult> {
  const q = await getQuote(actor, quoteId);
  if (!q || q.role !== "buyer") throw new DomainError("not_found", "Quote not found");
  if (decision !== "accept" && decision !== "decline") throw new DomainError("validation", "Invalid decision");
  const isMember = await assertCan(actor, "quote.decide");
  if (decision === "decline") { await reportDeal(actor, q.matchId, "lost"); return { status: "declined", requestId: null }; }
  // Per-line quote (docs/design/rfq-multiline.md): accepting it awards every priced line that is still open, so the value
  // that needs approval is the total of those lines, not the whole quote.
  const free = q.lineTotals ? await openPricedLines(q) : null;
  if (free && free.length === 0) throw new DomainError("conflict", "Every line in this quote has already been awarded.");
  const total = free ? free.reduce((sum, l) => sum + (l.lineTotalPaise ?? 0), 0) : await quoteTotalPaise(q);
  // docs/design/buyer-approvals.md: a matching rule (or the member's spend limit) holds the acceptance until the chain signs off;
  // the held acceptance then completes from the ApprovalApproved event (resumeApprovedQuote).
  const gate = await consult(actor, { action: "quote_accept", amountPaise: total, subject: { type: "quote", id: quoteId, summary: `${q.enquiryTitle} (₹${(total / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })})`.slice(0, 190) } }, isMember);
  if (gate.status === "pending") return { status: "pending_approval", requestId: gate.requestId };
  if (gate.status === "rejected") throw new DomainError("conflict", "The approval for this quote was rejected.");
  await completeAcceptance(actor, q, quoteId, total, isMember);
  return { status: "accepted", requestId: gate.requestId };
}

export interface DecideQuoteResult {
  status: "accepted" | "declined" | "pending_approval";
  requestId: string | null;
}

/** Priced (not "can't supply") lines of a per-line quote that no supplier has been awarded yet. */
async function openPricedLines(q: QuoteView) {
  const open = (q.lines ?? []).filter((l) => !l.cantSupply && l.lineTotalPaise !== null);
  const taken = new Set((await prisma.enquiryLineAward.findMany({ where: { enquiryId: q.enquiryId }, select: { enquiryLineId: true } })).map((a) => a.enquiryLineId));
  return open.filter((l) => !taken.has(l.enquiryLineId));
}

/** Per-unit price x the requested quantity (the quote's own quantity when none was requested), from stored data only. */
async function quoteTotalPaise(q: { enquiryId: string; pricePaise: number; quantity: number }): Promise<number> {
  const enq = await prisma.enquiry.findUnique({ where: { id: q.enquiryId }, select: { quantity: true } });
  return q.pricePaise * (enq?.quantity ?? q.quantity);
}

/**
 * Records the buyer's "won" (creating the order record) and the spend. A per-line quote awards its open priced lines instead
 * (one won deal + order with only those lines). Idempotent: a repeated call or event redelivery changes nothing.
 */
async function completeAcceptance(actor: Actor, q: QuoteView, quoteId: string, total: number, isMember: boolean): Promise<void> {
  if (q.lineTotals) {
    const free = await openPricedLines(q);
    if (free.length === 0) return; // already awarded (redelivery) or taken by another supplier meanwhile
    await applyLineAwards(actor, q.enquiryId, free.map((l) => ({ enquiryLineId: l.enquiryLineId, quoteId })));
  } else {
    const already = await prisma.dealReport.findFirst({ where: { matchId: q.matchId, reportedByBusinessId: actor.businessId, outcome: "won" }, select: { id: true } });
    if (!already) await reportDeal(actor, q.matchId, "won", total);
  }
  if (isMember) await recordSpend({ businessId: actor.businessId, personId: actor.personId, amountPaise: total, action: "quote_accept", subject: { type: "quote", id: quoteId } });
}

/**
 * ApprovalApproved for a quote: completes the acceptance the requester asked for, as the requester. Quietly ignores a quote that is
 * no longer acceptable (the lead closed meanwhile): retrying could never succeed.
 */
export async function resumeApprovedQuote(p: { businessId: string; subjectId: string; requesterPersonId: string }): Promise<void> {
  const actor: Actor = { personId: p.requesterPersonId, businessId: p.businessId };
  const q = await getQuote(actor, p.subjectId);
  if (!q || q.role !== "buyer") return;
  try {
    const free = q.lineTotals ? await openPricedLines(q) : null;
    const total = free ? free.reduce((sum, l) => sum + (l.lineTotalPaise ?? 0), 0) : await quoteTotalPaise(q);
    await completeAcceptance(actor, q, p.subjectId, total, true);
  } catch (e) {
    if (e instanceof DomainError && (e.code === "conflict" || e.code === "not_found")) return;
    throw e;
  }
}
