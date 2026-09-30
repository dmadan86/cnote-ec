// "Report offer not honoured" (design 6.2 rule 7). Offers are indicative prices the seller must honour for enquiries at or above
// the tier quantity during the window. Upheld reports emit OfferHonourDecided(upheld: true): identity turns that into a small
// negative trust signal (ADR-003), and above a threshold the seller's offer privileges are suspended.
import { DomainError, emit, rateLimit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { DAY_MS, OFFER } from "./config";
import { getListingFacts } from "./ports";
import { suspendSellerOffers, upheldReportCount } from "./offers";

export interface HonourReportView {
  id: string;
  offerId: string;
  reportedByBusinessId: string;
  enquiryId: string | null;
  note: string | null;
  upheld: boolean | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}
type Row = NonNullable<Awaited<ReturnType<typeof prisma.offerHonourReport.findUnique>>>;
const toView = (r: Row): HonourReportView => ({
  id: r.id, offerId: r.offerId, reportedByBusinessId: r.reportedByBusinessId, enquiryId: r.enquiryId, note: r.note, upheld: r.upheld, decidedBy: r.decidedBy,
  decidedAt: r.decidedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
});

/** Reports may be filed while the offer runs and for 7 days afterwards (a buyer often discovers it on the follow-up call). */
const REPORT_GRACE_MS = 7 * DAY_MS;

export async function reportOfferNotHonoured(input: { offerId: string; reporterBusinessId: string; note?: string | null; enquiryId?: string | null }, now = new Date()): Promise<HonourReportView> {
  const note = input.note?.trim().slice(0, 1000) || null;
  if (!/^[0-9a-f-]{36}$/i.test(input.offerId)) throw new DomainError("not_found", "Offer not found");
  if (!(await rateLimit(`offer-report:${input.reporterBusinessId}`, 10, 86_400))) throw new DomainError("rate_limited", "Too many reports today. Please try again tomorrow.");
  const offer = await prisma.listingOffer.findUnique({ where: { id: input.offerId } });
  if (!offer || !offer.referenceComputedAt) throw new DomainError("not_found", "Offer not found");
  if (offer.sellerBusinessId === input.reporterBusinessId) throw new DomainError("forbidden", "You cannot report your own offer");
  const closedAt = offer.status === "active" ? null : offer.endsAt && offer.endsAt < offer.updatedAt ? offer.endsAt : offer.updatedAt;
  if (offer.startsAt > now || (closedAt && now.getTime() > closedAt.getTime() + REPORT_GRACE_MS)) throw new DomainError("validation", "This offer is no longer open for reports.");
  const dup = await prisma.offerHonourReport.findFirst({ where: { offerId: offer.id, reportedByBusinessId: input.reporterBusinessId, upheld: null } });
  if (dup) return toView(dup);
  const row = await prisma.$transaction(async (tx) => {
    const r = await tx.offerHonourReport.create({ data: { offerId: offer.id, reportedByBusinessId: input.reporterBusinessId, enquiryId: input.enquiryId ?? null, note } });
    await emit(tx, "OfferHonourReported", { type: "offer", id: offer.id }, { reportId: r.id, offerId: offer.id, sellerBusinessId: offer.sellerBusinessId, reportedByBusinessId: input.reporterBusinessId });
    return r;
  });
  return toView(row);
}

/** Staff decision (`offers.review`). Upheld => OfferHonourDecided(upheld) feeds trust; repeat offenders lose offer privileges. */
export async function decideHonourReport(reportId: string, decision: { upheld: boolean; decidedBy: string }, now = new Date()): Promise<HonourReportView & { sellerSuspended: boolean }> {
  const r = /^[0-9a-f-]{36}$/i.test(reportId) ? await prisma.offerHonourReport.findUnique({ where: { id: reportId }, include: { offer: true } }) : null;
  if (!r) throw new DomainError("not_found", "Report not found");
  if (r.upheld !== null) throw new DomainError("conflict", "This report has already been decided");
  const updated = await prisma.$transaction(async (tx) => {
    const n = await tx.offerHonourReport.updateMany({ where: { id: r.id, upheld: null }, data: { upheld: decision.upheld, decidedBy: decision.decidedBy, decidedAt: now } });
    if (n.count === 0) throw new DomainError("conflict", "This report has already been decided");
    await emit(tx, "OfferHonourDecided", { type: "offer", id: r.offerId }, { reportId: r.id, offerId: r.offerId, sellerBusinessId: r.offer.sellerBusinessId, upheld: decision.upheld });
    return tx.offerHonourReport.findUniqueOrThrow({ where: { id: r.id } });
  });
  let sellerSuspended = false;
  if (decision.upheld && (await upheldReportCount(r.offer.sellerBusinessId, now)) >= OFFER.suspendAfterUpheld) {
    await suspendSellerOffers(r.offer.sellerBusinessId, decision.decidedBy, "Offer privileges paused after repeated upheld honour reports");
    sellerSuspended = true;
  }
  return { ...toView(updated), sellerSuspended };
}

export async function listHonourReports(opts: { status?: "open" | "decided"; limit?: number } = {}): Promise<(HonourReportView & { sellerBusinessId: string; listingId: string; listingTitle: string | null; offerKind: string })[]> {
  const rows = await prisma.offerHonourReport.findMany({
    where: opts.status === "decided" ? { upheld: { not: null } } : { upheld: null },
    orderBy: { createdAt: opts.status === "decided" ? "desc" : "asc" },
    take: Math.min(opts.limit ?? 100, 200),
    include: { offer: true },
  });
  const titles = new Map<string, string | null>();
  for (const id of new Set(rows.map((r) => r.offer.listingId))) titles.set(id, (await getListingFacts(id))?.title ?? null);
  return rows.map((r) => ({ ...toView(r), sellerBusinessId: r.offer.sellerBusinessId, listingId: r.offer.listingId, listingTitle: titles.get(r.offer.listingId) ?? null, offerKind: r.offer.kind }));
}
