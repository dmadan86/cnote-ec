// Candidate retrieval, offering and cascade (ADR-002).
import * as catalogue from "@cnote/catalogue";
import { DomainError, emit } from "@cnote/core";
import { prisma, type Enquiry, type Tx } from "@cnote/db";
import { assignSlots, rankCandidates, type Geo, type RankedCandidate, type SellerSignals } from "./scoring";
import { categoryById, lockRow, profiles, RESPOND_WINDOW_MS } from "./support";

const CANDIDATE_LIMIT = 25;

export async function loadEmbedding(enquiryId: string): Promise<number[]> {
  const rows = await prisma.$queryRaw<{ e: string | null }[]>`SELECT embedding::text AS e FROM enquiries WHERE id = ${enquiryId}::uuid`;
  const e = rows[0]?.e;
  if (!e) throw new DomainError("conflict", "Enquiry has no embedding yet");
  return JSON.parse(e) as number[];
}

/** Ranked eligible sellers for an enquiry (never the buyer's own business). */
export async function rankedCandidates(
  enq: Enquiry,
  opts: { exclude?: string[]; preferredSellerId?: string | null } = {},
): Promise<RankedCandidate[]> {
  const embedding = await loadEmbedding(enq.id);
  const exclude = [enq.buyerBusinessId, ...(opts.exclude ?? [])];
  const candidates = await catalogue.findSellerCandidates({
    embedding,
    categoryId: enq.categoryId,
    limit: CANDIDATE_LIMIT,
    excludeSellerIds: exclude,
  });
  const profs = await profiles([enq.buyerBusinessId, ...candidates.map((c) => c.sellerBusinessId)]);
  const buyerProfile = profs.get(enq.buyerBusinessId);
  // Delivery location wins; fall back to the buyer's business location.
  const buyerGeo: Geo = {
    city: enq.deliveryCity ?? buyerProfile?.city,
    pincode: enq.deliveryPincode ?? buyerProfile?.pincode,
    state: enq.deliveryCity && enq.deliveryCity !== buyerProfile?.city ? null : buyerProfile?.state,
  };
  const signals = new Map<string, SellerSignals>(profs);
  return rankCandidates(candidates, signals, buyerGeo, { exclude, preferredSellerId: opts.preferredSellerId });
}

/** Creates offered Match rows (+ LeadMatched) in the caller's tx. */
export async function offerMatches(tx: Tx, enq: Pick<Enquiry, "id">, picks: { rank: number; candidate: RankedCandidate }[]): Promise<void> {
  const respondBy = new Date(Date.now() + RESPOND_WINDOW_MS);
  for (const { rank, candidate } of picks) {
    const m = await tx.match.create({
      data: { enquiryId: enq.id, sellerBusinessId: candidate.sellerBusinessId, rank, matchScore: candidate.matchScore, respondBy },
    });
    await emit(tx, "LeadMatched", { type: "enquiry", id: enq.id }, {
      enquiryId: enq.id, matchId: m.id, sellerBusinessId: m.sellerBusinessId, rank, matchScore: candidate.matchScore,
    });
  }
}

export async function leadCapFor(enq: Enquiry): Promise<number> {
  return (await categoryById(enq.categoryId))?.leadCap ?? enq.sellerCap ?? 3;
}

/** Synchronous matching for a freshly scored/approved enquiry. Idempotent (only runs from "scoring"). */
export async function runMatching(enquiryId: string, opts: { preferredSellerId?: string | null } = {}): Promise<void> {
  const enq = await prisma.enquiry.findUnique({ where: { id: enquiryId } });
  if (!enq || enq.status !== "scoring" || enq.buyerPicks) return; // buyerPicks: wait for pickSellers
  const cap = await leadCapFor(enq);
  const top = (await rankedCandidates(enq, opts)).slice(0, cap);
  await prisma.$transaction(async (tx) => {
    await lockRow(tx, "enquiries", enquiryId);
    const fresh = await tx.enquiry.findUnique({ where: { id: enquiryId } });
    if (!fresh || fresh.status !== "scoring") return;
    await offerMatches(tx, enq, top.map((candidate, i) => ({ rank: i + 1, candidate })));
    await tx.enquiry.update({ where: { id: enquiryId }, data: { sellerCap: cap, status: top.length ? "matched" : "unmatched" } });
  });
}

/**
 * Refill vacated slots after a decline/expiry: offer to the next-best unoffered candidates so that
 * at most `sellerCap` matches are active (offered or accepted). Re-runs the candidate query
 * excluding every seller already offered. Skipped for buyer-picks enquiries (buyer chooses).
 */
export async function cascade(enquiryId: string): Promise<number> {
  const enq = await prisma.enquiry.findUnique({ where: { id: enquiryId }, include: { matches: true } });
  if (!enq || enq.status !== "matched" || enq.buyerPicks) return 0;
  const active = enq.matches.filter((m) => m.status === "offered" || m.status === "accepted");
  if (active.length >= enq.sellerCap) return 0;
  const ranked = await rankedCandidates(enq, { exclude: enq.matches.map((m) => m.sellerBusinessId) });
  let offered = 0;
  await prisma.$transaction(async (tx) => {
    await lockRow(tx, "enquiries", enquiryId);
    const current = await tx.match.findMany({ where: { enquiryId } });
    const activeNow = current.filter((m) => m.status === "offered" || m.status === "accepted");
    const taken = new Set(current.map((m) => m.sellerBusinessId));
    const slots = assignSlots(ranked.filter((r) => !taken.has(r.sellerBusinessId)), activeNow.map((m) => m.rank), enq.sellerCap);
    await offerMatches(tx, enq, slots);
    offered = slots.length;
    if (activeNow.length === 0 && slots.length === 0) await tx.enquiry.update({ where: { id: enquiryId }, data: { status: "unmatched" } });
  });
  return offered;
}
