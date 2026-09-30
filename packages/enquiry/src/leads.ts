// Seller-side lead actions (ADR-002, ADR-005).
import * as billing from "@cnote/billing";
import { DomainError, emit } from "@cnote/core";
import { prisma, type Enquiry, type Match, type Tx } from "@cnote/db";
import * as identity from "@cnote/identity";
import { cascade } from "./matching";
import { cascadeSafe } from "./safe";
import { runMatching } from "./matching";
import { createCheck, enqueueDispatch, pendingChecksByMatch, reachabilityEnabled, resolveReachabilityCheck } from "./reachability";
import { categories, enquiryBase, lockRow, personContact, profiles, REFUND_WINDOW_MS } from "./support";
import type { Actor, LeadView } from "./types";

const NO_PHONE_NOTE = "The buyer has not shared a phone number. Use in-app chat to reach them.";

async function toLeadViews(rows: { match: Match; enquiry: Enquiry; conversationId: string | null }[]): Promise<LeadView[]> {
  const cats = await categories();
  const profs = await profiles(rows.map((r) => r.enquiry.buyerBusinessId));
  const out: LeadView[] = [];
  const pending = await pendingChecksByMatch(rows.map((r) => r.match.id));
  for (const { match, enquiry, conversationId } of rows) {
    const buyer = profs.get(enquiry.buyerBusinessId);
    const revealed = match.status === "accepted";
    let phone: string | null = null;
    let contactNote: string | null = null;
    if (revealed) {
      if (await identity.hasConsent(enquiry.buyerPersonId, "counterparty_sharing")) {
        phone = (await personContact(enquiry.buyerPersonId))?.phone ?? null;
        if (!phone) contactNote = NO_PHONE_NOTE;
      } else contactNote = NO_PHONE_NOTE;
    }
    out.push({
      matchId: match.id,
      enquiry: enquiryBase(enquiry, cats.find((c) => c.id === enquiry.categoryId) ?? null),
      rank: match.rank,
      of: enquiry.sellerCap,
      status: match.status,
      respondBy: match.respondBy.toISOString(),
      // Identity stays hidden until the seller pays a credit by accepting (ADR-002).
      buyer: {
        businessName: revealed ? (buyer?.name ?? "Buyer") : "Hidden until you accept",
        city: revealed ? (buyer?.city ?? null) : null,
        verificationTier: buyer?.verificationTier ?? 0,
        phone,
      },
      conversationId,
      contactNote,
      reachabilityCheck: pending.has(match.id) ? { status: "checking", expiresAt: pending.get(match.id)!.expiresAt } : null,
    });
  }
  return out;
}

export async function listSellerLeads(sellerBusinessId: string): Promise<LeadView[]> {
  const matches = await prisma.match.findMany({
    where: { sellerBusinessId },
    include: { enquiry: true, conversation: { select: { id: true } } },
    orderBy: { offeredAt: "desc" },
    take: 200,
  });
  return toLeadViews(matches.map(({ enquiry, conversation, ...match }) => ({ match, enquiry, conversationId: conversation?.id ?? null })));
}

export async function getSellerLead(sellerBusinessId: string, matchId: string): Promise<LeadView | null> {
  const m = await prisma.match.findFirst({
    where: { id: matchId, sellerBusinessId },
    include: { enquiry: true, conversation: { select: { id: true } } },
  });
  if (!m) return null;
  const { enquiry, conversation, ...match } = m;
  return (await toLeadViews([{ match, enquiry, conversationId: conversation?.id ?? null }]))[0]!;
}

/** Consumes one credit, reveals buyer, opens a conversation. All in one transaction. */
export async function acceptLead(actor: Actor, matchId: string): Promise<LeadView> {
  await prisma.$transaction(
    async (tx) => {
      await lockRow(tx, "matches", matchId);
      const m = await tx.match.findUnique({ where: { id: matchId } });
      if (!m || m.sellerBusinessId !== actor.businessId) throw new DomainError("not_found", "Lead not found");
      if (m.status === "accepted") return; // double-click / retry
      if (m.status !== "offered") throw new DomainError("conflict", "This lead is no longer available.");
      const now = new Date();
      if (now > m.respondBy) throw new DomainError("conflict", "The 2-hour response window for this lead has passed.");
      const enq = await tx.enquiry.findUnique({ where: { id: m.enquiryId } });
      if (!enq || enq.status !== "matched") throw new DomainError("conflict", "This requirement is no longer open.");

      const creditTxnId = await billing.consumeCredit(tx, actor.businessId, { refType: "match", refId: matchId });
      await tx.match.update({ where: { id: matchId }, data: { status: "accepted", respondedAt: now, creditTxnId } });
      const convo = await tx.conversation.create({ data: { matchId } });
      await emit(tx, "LeadAccepted", { type: "enquiry", id: m.enquiryId }, {
        enquiryId: m.enquiryId, matchId, sellerBusinessId: m.sellerBusinessId, creditTxnId, responseMs: now.getTime() - m.offeredAt.getTime(),
      });
      await emit(tx, "ConversationStarted", { type: "conversation", id: convo.id }, { conversationId: convo.id, matchId });
    },
    { timeout: 10_000 },
  );
  return (await getSellerLead(actor.businessId, matchId))!;
}

/** Marks an offered match with a terminal status inside a tx; false if it was no longer offered. */
async function closeOffer(tx: Tx, m: Match, status: "declined" | "expired", reason?: string): Promise<boolean> {
  const { count } = await tx.match.updateMany({ where: { id: m.id, status: "offered" }, data: { status, respondedAt: new Date() } });
  if (count === 0) return false;
  const base = { enquiryId: m.enquiryId, matchId: m.id, sellerBusinessId: m.sellerBusinessId };
  if (status === "declined") await emit(tx, "LeadDeclined", { type: "enquiry", id: m.enquiryId }, { ...base, reason });
  else await emit(tx, "LeadExpired", { type: "enquiry", id: m.enquiryId }, base);
  return true;
}

/** Within the 2h window; slot cascades to the next-ranked seller. */
export async function declineLead(actor: Actor, matchId: string, reason?: string): Promise<void> {
  const enquiryId = await prisma.$transaction(async (tx) => {
    await lockRow(tx, "matches", matchId);
    const m = await tx.match.findUnique({ where: { id: matchId } });
    if (!m || m.sellerBusinessId !== actor.businessId) throw new DomainError("not_found", "Lead not found");
    if (m.status === "declined") return null;
    if (m.status !== "offered") throw new DomainError("conflict", "This lead can no longer be declined.");
    await closeOffer(tx, m, "declined", reason?.slice(0, 200));
    return m.enquiryId;
  });
  if (enquiryId) await cascadeSafe(enquiryId);
}

/** Job: offers past respondBy → expired + LeadExpired, then cascade. Returns number expired. */
export async function expireOverdueOffers(now = new Date()): Promise<number> {
  const due = await prisma.match.findMany({ where: { status: "offered", respondBy: { lt: now } }, take: 200 });
  let n = 0;
  for (const d of due) {
    const closed = await prisma.$transaction(async (tx) => {
      await lockRow(tx, "matches", d.id);
      return closeOffer(tx, d, "expired");
    });
    if (closed) {
      n++;
      await cascadeSafe(d.enquiryId);
    }
  }
  return n;
}

/** Refunds one accepted match inside the tx: status → refunded, credit returned, LeadRefunded. */
export async function refundMatch(tx: Tx, m: Match, reason: "buyer_unreachable" | "buyer_fake" | "enquiry_rejected") {
  await tx.match.update({ where: { id: m.id }, data: { status: "refunded", refundReason: reason } });
  if (m.creditTxnId) await billing.refundCredit(tx, m.creditTxnId);
  await emit(tx, "LeadRefunded", { type: "enquiry", id: m.enquiryId }, { enquiryId: m.enquiryId, matchId: m.id, sellerBusinessId: m.sellerBusinessId, reason });
}

const FAKE_FLAGS_TO_REJECT = 2;

/**
 * Seller flags buyer unreachable/fake within 72h of accepting → auto-refund, no ticket (ADR-002).
 * 2+ distinct sellers flagging "fake" (one match per seller per enquiry) rejects the enquiry and refunds
 * every accepted match.
 */
export async function reportBuyerProblem(actor: Actor, matchId: string, kind: "buyer_unreachable" | "buyer_fake"): Promise<void> {
  // "unreachable" with the check enabled: the refund is held while we verify with the buyer (ADR-002 outreach).
  let checkId: string | null = null;
  let settleId: string | null = null;
  await prisma.$transaction(async (tx) => {
    await lockRow(tx, "matches", matchId);
    const m = await tx.match.findUnique({ where: { id: matchId } });
    if (!m || m.sellerBusinessId !== actor.businessId) throw new DomainError("not_found", "Lead not found");
    if (m.status === "refunded") return; // already handled
    if (m.status !== "accepted" || !m.respondedAt) throw new DomainError("conflict", "Only accepted leads can be reported.");
    if (Date.now() - m.respondedAt.getTime() > REFUND_WINDOW_MS) throw new DomainError("conflict", "The 72-hour refund window for this lead has passed.");
    if (kind === "buyer_unreachable" && reachabilityEnabled()) {
      const checks = await tx.reachabilityCheck.findMany({ where: { matchId } });
      if (checks.some((c) => c.status === "responded")) throw new DomainError("conflict", "The buyer confirmed they still need this. Please contact them again.");
      if (checks.some((c) => c.status === "sent" || c.status === "failed" || c.status === "no_response")) {
        settleId = checks.find((c) => c.status !== "sent")?.id ?? null; // failed/expired-but-unresolved: settle now; a live check just waits
        return;
      }
      checkId = await createCheck(tx, m.enquiryId, matchId);
      return;
    }
    await refundMatch(tx, m, kind);
    if (kind !== "buyer_fake") return;

    const flags = await tx.match.count({ where: { enquiryId: m.enquiryId, refundReason: "buyer_fake" } });
    if (flags < FAKE_FLAGS_TO_REJECT) return;
    await lockRow(tx, "enquiries", m.enquiryId);
    await tx.enquiry.update({ where: { id: m.enquiryId }, data: { status: "rejected", moderationStatus: "rejected" } });
    for (const other of await tx.match.findMany({ where: { enquiryId: m.enquiryId, id: { not: m.id } } })) {
      if (other.status === "accepted") await refundMatch(tx, other, "enquiry_rejected");
      else if (other.status === "offered") await closeOffer(tx, other, "expired");
    }
  });
  if (settleId) await resolveReachabilityCheck(settleId);
  if (!checkId) return;
  // Delivered by the worker (see reachability.ts); a delivery failure there settles the check immediately.
  await enqueueDispatch(checkId);
}

/** Ops release/reject of an enquiry held in review (low confidence). */
export async function resolveEnquiryReview(enquiryId: string, outcome: "approved" | "rejected"): Promise<void> {
  const held = await prisma.$transaction(async (tx) => {
    await lockRow(tx, "enquiries", enquiryId);
    const e = await tx.enquiry.findUnique({ where: { id: enquiryId } });
    if (!e) throw new DomainError("not_found", "Enquiry not found");
    if (e.status !== "review") throw new DomainError("conflict", "This enquiry is not awaiting review.");
    await tx.enquiry.update({
      where: { id: enquiryId },
      data: outcome === "approved" ? { status: "scoring", moderationStatus: "approved" } : { status: "rejected", moderationStatus: "rejected" },
    });
    return outcome === "approved";
  });
  if (held) await runMatching(enquiryId);
}

/** Job: retry cascades that failed after their trigger committed (free slots on recent matched enquiries). */
export async function repairCascades(): Promise<number> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT e.id FROM enquiries e
    WHERE e.status = 'matched' AND NOT e.buyer_picks AND e.created_at > now() - interval '3 days'
      AND (SELECT count(*) FROM matches m WHERE m.enquiry_id = e.id AND m.status IN ('offered','accepted')) < e.seller_cap
      AND EXISTS (SELECT 1 FROM matches m WHERE m.enquiry_id = e.id AND m.status IN ('declined','expired') AND m.responded_at > now() - interval '1 day')
    LIMIT 50`;
  let n = 0;
  for (const { id } of rows) n += await cascade(id).catch(() => 0);
  return n;
}

/** Job: enquiries stuck in "scoring" (crash between create and match) get matched. */
export async function sweepStuckScoring(): Promise<number> {
  const rows = await prisma.enquiry.findMany({
    where: { status: "scoring", buyerPicks: false, moderationStatus: "approved", createdAt: { lt: new Date(Date.now() - 2 * 60_000), gt: new Date(Date.now() - 86_400_000) } },
    select: { id: true },
    take: 50,
  });
  for (const r of rows) await runMatching(r.id).catch((e) => console.error("[enquiry] sweep match failed", r.id, e));
  return rows.length;
}
