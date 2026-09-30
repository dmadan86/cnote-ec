// Buyer-side reads and the buyer-picks flow.
import { DomainError } from "@cnote/core";
import { prisma, type Enquiry, type Match } from "@cnote/db";
import { leadCapFor, offerMatches, rankedCandidates } from "./matching";
import { categories, enquiryBase, lockRow, matchView, profiles } from "./support";
import type { Actor, CandidateView, EnquiryView } from "./types";

type Row = Enquiry & { matches: (Match & { conversation: { id: string } | null })[] };

async function toViews(rows: Row[]): Promise<EnquiryView[]> {
  const cats = await categories();
  const profs = await profiles(rows.flatMap((r) => r.matches.map((m) => m.sellerBusinessId)));
  return rows.map((e) => ({
    ...enquiryBase(e, cats.find((c) => c.id === e.categoryId) ?? null),
    matches: [...e.matches]
      .sort((a, b) => a.rank - b.rank)
      .map((m) => matchView(m, e.sellerCap, profs.get(m.sellerBusinessId), m.conversation?.id ?? null)),
    awaitingPick: e.buyerPicks && e.status === "scoring" && e.matches.length === 0,
  }));
}

const include = { matches: { include: { conversation: { select: { id: true } } } } } as const;

export async function listBuyerEnquiries(buyerBusinessId: string): Promise<EnquiryView[]> {
  const rows = await prisma.enquiry.findMany({ where: { buyerBusinessId }, include, orderBy: { createdAt: "desc" }, take: 100 });
  return toViews(rows);
}

export async function getBuyerEnquiry(buyerBusinessId: string, enquiryId: string): Promise<EnquiryView | null> {
  const row = await prisma.enquiry.findFirst({ where: { id: enquiryId, buyerBusinessId }, include });
  return row ? (await toViews([row]))[0]! : null;
}

async function ownedEnquiry(actor: Actor, enquiryId: string) {
  const enq = await prisma.enquiry.findFirst({ where: { id: enquiryId, buyerBusinessId: actor.businessId } });
  if (!enq) throw new DomainError("not_found", "Requirement not found");
  return enq;
}

/** ADR-002 option 4: ranked candidates for a buyer-picks enquiry (excludes sellers already offered). */
export async function listCandidatesForBuyer(actor: Actor, enquiryId: string): Promise<CandidateView[]> {
  const enq = await ownedEnquiry(actor, enquiryId);
  if (!enq.buyerPicks || !["scoring", "matched", "unmatched"].includes(enq.status)) return [];
  const offered = (await prisma.match.findMany({ where: { enquiryId }, select: { sellerBusinessId: true } })).map((m) => m.sellerBusinessId);
  const ranked = await rankedCandidates(enq, { exclude: offered });
  const profs = await profiles(ranked.map((r) => r.sellerBusinessId));
  return ranked.map((r) => {
    const p = profs.get(r.sellerBusinessId)!;
    return {
      sellerBusinessId: r.sellerBusinessId,
      sellerName: p.name,
      listingId: r.listingId,
      matchScore: r.matchScore,
      similarity: r.similarity,
      verificationTier: p.verificationTier,
      badgeActive: p.badgeActive,
      trustScore: p.trustScore,
      city: p.city,
    };
  });
}

/** Buyer selects sellers (in order of preference, up to the lead cap minus active matches). */
export async function pickSellers(actor: Actor, enquiryId: string, sellerIds: string[]): Promise<EnquiryView> {
  const enq = await ownedEnquiry(actor, enquiryId);
  if (!enq.buyerPicks) throw new DomainError("conflict", "This requirement is matched automatically.", undefined, "enquiries.requirementMatchedAutomatically");
  if (!["scoring", "matched", "unmatched"].includes(enq.status)) throw new DomainError("conflict", "This requirement is not open for picking.");
  const chosen = [...new Set(sellerIds)];
  if (chosen.length === 0) throw new DomainError("validation", "Pick at least one seller.");
  const cap = await leadCapFor(enq);
  const existing = await prisma.match.findMany({ where: { enquiryId } });
  const active = existing.filter((m) => m.status === "offered" || m.status === "accepted");
  if (active.length + chosen.length > cap) throw new DomainError("validation", `You can pick up to ${cap - active.length} more seller(s).`, undefined, "enquiries.pickUpMoreSellerS", { count: cap - active.length });
  const ranked = await rankedCandidates(enq, { exclude: existing.map((m) => m.sellerBusinessId) });
  const byId = new Map(ranked.map((r) => [r.sellerBusinessId, r]));
  const picks = chosen.map((id) => byId.get(id));
  if (picks.some((p) => !p)) throw new DomainError("validation", "One of the selected sellers is no longer available.", undefined, "enquiries.oneSelectedSellersNoLonger");
  const usedRanks = new Set(active.map((m) => m.rank));
  const freeRanks: number[] = [];
  for (let r = 1; freeRanks.length < picks.length && r <= cap; r++) if (!usedRanks.has(r)) freeRanks.push(r);
  await prisma.$transaction(async (tx) => {
    await lockRow(tx, "enquiries", enquiryId);
    const fresh = await tx.enquiry.findUnique({ where: { id: enquiryId } });
    if (!fresh || !["scoring", "matched", "unmatched"].includes(fresh.status)) throw new DomainError("conflict", "This requirement is not open for picking.");
    await offerMatches(tx, enq, picks.map((candidate, i) => ({ rank: freeRanks[i]!, candidate: candidate! })));
    await tx.enquiry.update({ where: { id: enquiryId }, data: { sellerCap: cap, status: "matched" } });
  });
  return (await getBuyerEnquiry(actor.businessId, enquiryId))!;
}
