// Buyer-side quote comparison and the "My requirements" board status (ADR-002 transparency, ADR-007 lifecycle).
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { quoteAttachments, type AttachmentView } from "./attachments";
import { reportDeal } from "./messaging";
import { getQuote, toQuoteView, type QuoteView } from "./quotes";
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
  /** Which quantity `totalPaise` was computed for. */
  quantityBasis: "requested" | "quoted";
  quantity: number;
  /** Latest off-platform deal report on this match: "won" = accepted, "lost" = declined. */
  decision: "won" | "lost" | "pending" | null;
  /** Earlier quotes this seller replaced (only the latest is compared). */
  earlierQuotes: number;
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
  const [profs, files] = await Promise.all([
    profiles(withQuotes.map((m) => m.sellerBusinessId)),
    quoteAttachments(withQuotes.flatMap((m) => m.conversation!.quotes.map((q) => q.id))),
  ]);
  const rows: ComparisonRow[] = withQuotes
    .map((m) => {
      const quotes = m.conversation!.quotes;
      const latest = quotes[quotes.length - 1]!;
      const p = profs.get(m.sellerBusinessId);
      const view = toQuoteView(latest);
      const requested = enq.quantity ?? null;
      const quantity = requested ?? latest.quantity;
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
        totalPaise: Number(latest.pricePaise) * quantity,
        quantityBasis: requested === null ? ("quoted" as const) : ("requested" as const),
        quantity,
        // a seller-reported "won" is an unconfirmed claim, never the buyer's decision (security audit M7)
        decision: m.dealReports.find((r) => !(r.outcome === "won" && r.reportedByBusinessId === m.sellerBusinessId))?.outcome ?? null,
        earlierQuotes: quotes.length - 1,
      };
    })
    .sort((a, b) => a.rank - b.rank);
  return {
    enquiryId: enq.id,
    quantity: enq.quantity,
    quantityUnit: enq.quantityUnit,
    sentTo: enq.matches.length,
    quotesFrom: rows.length,
    expiresAt: enq.expiresAt ? enq.expiresAt.toISOString() : null,
    rows,
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
export async function decideQuote(actor: Actor, quoteId: string, decision: "accept" | "decline"): Promise<void> {
  const q = await getQuote(actor, quoteId);
  if (!q || q.role !== "buyer") throw new DomainError("not_found", "Quote not found");
  if (decision !== "accept" && decision !== "decline") throw new DomainError("validation", "Invalid decision");
  if (decision === "decline") { await reportDeal(actor, q.matchId, "lost"); return; }
  const enq = await prisma.enquiry.findUnique({ where: { id: q.enquiryId }, select: { quantity: true } });
  await reportDeal(actor, q.matchId, "won", q.pricePaise * (enq?.quantity ?? q.quantity));
}
