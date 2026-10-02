// Per-seller refund guard (security audit M2). ADR-002's promise stays: a genuine "buyer is fake" report inside 72h refunds
// instantly with no ticket. But a seller who farms refunds (accept many leads, flag them all as fake) must not get an
// unlimited free lead stream, so once a seller's refund rate or burst crosses a threshold further buyer_fake reports are
// HELD for staff review instead of refunding instantly. Thresholds are env-configurable; staff approve or reject.
import { DomainError, emit } from "@cnote/core";
import { prisma, type Match, type Tx } from "@cnote/db";
import { lockRow } from "./support";

const DAY = 86_400_000;
const int = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isInteger(n) && n >= 0 ? n : d;
};

export interface RefundGuardConfig {
  /** hold when (refunds + this one) / accepted leads in the last 30 days exceeds this (basis points; default 20%) */
  rateBps: number;
  /** the rate only applies once the seller has at least this many accepted leads in 30 days (small samples are noise) */
  minAccepted: number;
  /** hold once this many seller-initiated refunds already happened in the last 7 days */
  maxPerWeek: number;
}
export const refundGuardConfig = (env: NodeJS.ProcessEnv = process.env): RefundGuardConfig => ({
  rateBps: int(env.LEAD_REFUND_GUARD_RATE_BPS, 2000),
  minAccepted: int(env.LEAD_REFUND_GUARD_MIN_ACCEPTED, 5),
  maxPerWeek: int(env.LEAD_REFUND_GUARD_MAX_PER_WEEK, 5),
});

const SELLER_REFUND_REASONS = ["buyer_fake", "buyer_unreachable"];

export interface RefundGuardResult { hold: boolean; reason: "refund_rate" | "refund_burst" | null; refundRateBps: number }

/**
 * Evaluates the seller's refund history INCLUDING the refund being requested. Serialised per seller (advisory lock) so two
 * parallel reports cannot both slip under the threshold. `enquiry_rejected` refunds are the platform's decision, not the
 * seller's, so they are not counted against the seller.
 */
export async function evaluateRefundGuard(tx: Tx, sellerBusinessId: string, now = new Date(), cfg: RefundGuardConfig = refundGuardConfig()): Promise<RefundGuardResult> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`refund-guard:${sellerBusinessId}`}))`;
  const since30 = new Date(now.getTime() - 30 * DAY);
  const since7 = new Date(now.getTime() - 7 * DAY);
  const base = { sellerBusinessId, respondedAt: { gte: since30 } };
  const [accepted, refunded30, refunded7] = await Promise.all([
    tx.match.count({ where: { ...base, status: { in: ["accepted", "refunded"] } } }),
    tx.match.count({ where: { ...base, status: "refunded", refundReason: { in: SELLER_REFUND_REASONS } } }),
    // a refund happens within 72h of the accept, so the accept time is the window proxy (no separate refund timestamp)
    tx.match.count({ where: { sellerBusinessId, respondedAt: { gte: since7 }, status: "refunded", refundReason: { in: SELLER_REFUND_REASONS } } }),
  ]);
  const rateBps = accepted > 0 ? Math.round(((refunded30 + 1) * 10_000) / accepted) : 0;
  if (refunded7 >= cfg.maxPerWeek) return { hold: true, reason: "refund_burst", refundRateBps: rateBps };
  if (accepted >= cfg.minAccepted && rateBps > cfg.rateBps) return { hold: true, reason: "refund_rate", refundRateBps: rateBps };
  return { hold: false, reason: null, refundRateBps: rateBps };
}

/** Records the hold (idempotent per match) and tells the event log; the credit stays with the platform until staff decide. */
export async function holdRefundForReview(tx: Tx, m: Match, kind: "buyer_fake", g: RefundGuardResult): Promise<void> {
  const made = await tx.leadRefundReview.createMany({
    data: [{ matchId: m.id, enquiryId: m.enquiryId, sellerBusinessId: m.sellerBusinessId, kind, reason: g.reason ?? "refund_rate", refundRateBps: g.refundRateBps }],
    skipDuplicates: true,
  });
  if (made.count === 0) return;
  await emit(tx, "LeadRefundHeld", { type: "enquiry", id: m.enquiryId }, {
    enquiryId: m.enquiryId, matchId: m.id, sellerBusinessId: m.sellerBusinessId, kind, reason: g.reason ?? "refund_rate", refundRateBps: g.refundRateBps,
  });
}

export interface RefundReviewRow {
  id: string; matchId: string; enquiryId: string; sellerBusinessId: string; kind: string; reason: string; refundRateBps: number;
  status: string; createdAt: string; decidedAt: string | null;
}
const toRow = (r: NonNullable<Awaited<ReturnType<typeof prisma.leadRefundReview.findUnique>>>): RefundReviewRow => ({
  id: r.id, matchId: r.matchId, enquiryId: r.enquiryId, sellerBusinessId: r.sellerBusinessId, kind: r.kind, reason: r.reason, refundRateBps: r.refundRateBps,
  status: r.status, createdAt: r.createdAt.toISOString(), decidedAt: r.decidedAt?.toISOString() ?? null,
});

/** Staff queue: held refund requests, oldest first. */
export async function listRefundReviews(opts: { status?: "pending" | "approved" | "rejected"; limit?: number } = {}): Promise<RefundReviewRow[]> {
  const rows = await prisma.leadRefundReview.findMany({ where: { status: opts.status ?? "pending" }, orderBy: { createdAt: "asc" }, take: Math.min(opts.limit ?? 100, 200) });
  return rows.map(toRow);
}

/** Staff decision. Approve = refund the match now (credit back, conversation closed, contact revoked); reject = lead stays accepted. */
export async function resolveRefundReview(reviewId: string, decision: "approved" | "rejected", staffId: string): Promise<RefundReviewRow> {
  if (!/^[0-9a-f-]{36}$/i.test(reviewId)) throw new DomainError("not_found", "Refund review not found");
  if (decision !== "approved" && decision !== "rejected") throw new DomainError("validation", "Invalid decision");
  // lazy import: leads.ts imports this module for the guard (avoid a cycle at load time)
  const { refundMatch, rejectEnquiryIfFakeFlagsReached } = await import("./leads");
  return prisma.$transaction(async (tx) => {
    const r0 = await tx.leadRefundReview.findUnique({ where: { id: reviewId } });
    if (!r0) throw new DomainError("not_found", "Refund review not found");
    await lockRow(tx, "matches", r0.matchId);
    const r = await tx.leadRefundReview.findUniqueOrThrow({ where: { id: reviewId } });
    if (r.status !== "pending") return toRow(r);
    const m = await tx.match.findUnique({ where: { id: r.matchId } });
    if (decision === "approved" && m?.status === "accepted") {
      await refundMatch(tx, m, "buyer_fake");
      await rejectEnquiryIfFakeFlagsReached(tx, m);
    }
    const done = await tx.leadRefundReview.update({ where: { id: r.id }, data: { status: decision, decidedBy: staffId, decidedAt: new Date() } });
    await emit(tx, "LeadRefundReviewed", { type: "enquiry", id: r.enquiryId }, { enquiryId: r.enquiryId, matchId: r.matchId, sellerBusinessId: r.sellerBusinessId, decision, decidedBy: staffId });
    return toRow(done);
  });
}
