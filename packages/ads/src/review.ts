// Staff side (design 5.9): review queue, per-item decisions, suspension (kill switch), invalid-traffic queue.
// Every function here is called from an audited() admin action holding the matching privilege (ads.review / ads.suspend /
// ads.fraud.review); the staff id is recorded on the append-only AdReviewAction log too.
import { DomainError, emit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { invalidateSnapshot } from "./eligibility";

export const REASON_CODES = ["irrelevant_keyword", "trademark", "competitor_brand", "prohibited_category", "misleading_listing", "low_quality_listing", "other"] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export type ReviewSubject = { type: "listing" | "keyword" | "ad_group"; id: string };

export async function listReviewQueue(limit = 100) {
  const rows = await prisma.adCampaign.findMany({
    where: {
      OR: [
        { status: "pending_review" },
        { adGroups: { some: { OR: [{ status: "pending" }, { listings: { some: { reviewStatus: "pending" } } }, { keywords: { some: { reviewStatus: "pending" } } }] } }, status: { in: ["approved", "active", "exhausted", "paused"] } },
      ],
    },
    orderBy: { submittedAt: "asc" },
    take: Math.min(limit, 200),
    include: { adGroups: { include: { listings: { select: { reviewStatus: true } }, keywords: { select: { reviewStatus: true } } } } },
  });
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    sellerBusinessId: c.sellerBusinessId,
    submittedAt: c.submittedAt?.toISOString() ?? null,
    dailyBudgetPaise: Number(c.dailyBudgetPaise),
    pendingItems: c.adGroups.reduce((n, g) => n + g.listings.filter((l) => l.reviewStatus === "pending").length + g.keywords.filter((k) => k.reviewStatus === "pending").length, 0),
  }));
}

export async function getCampaignForReview(campaignId: string) {
  const c = await prisma.adCampaign.findUnique({
    where: { id: campaignId },
    include: { adGroups: { include: { listings: true, keywords: true } }, reviews: { orderBy: { createdAt: "desc" }, take: 50 } },
  });
  if (!c) throw new DomainError("not_found", "Campaign not found");
  return c;
}

/** Approve or reject ONE listing or keyword (or a whole ad group), so one bad keyword does not sink a campaign. */
export async function reviewItem(o: { campaignId: string; staffId: string; subject: ReviewSubject; decision: "approved" | "rejected"; reasonCode?: ReasonCode; note?: string }) {
  if (o.decision === "rejected" && !o.reasonCode) throw new DomainError("validation", "A reason code is required to reject");
  const data = { reviewStatus: o.decision, reviewNote: o.reasonCode ?? o.note ?? null };
  await prisma.$transaction(async (tx) => {
    const c = await tx.adCampaign.findUnique({ where: { id: o.campaignId } });
    if (!c) throw new DomainError("not_found", "Campaign not found");
    const s = o.subject;
    if (s.type === "listing") {
      const r = await tx.adGroupListing.updateMany({ where: { id: s.id, adGroup: { campaignId: o.campaignId } }, data: { ...data, ...(o.decision === "rejected" ? { eligible: false } : {}) } });
      if (!r.count) throw new DomainError("not_found", "Listing entry not found in this campaign");
    } else if (s.type === "keyword") {
      const r = await tx.adKeyword.updateMany({ where: { id: s.id, adGroup: { campaignId: o.campaignId } }, data });
      if (!r.count) throw new DomainError("not_found", "Keyword not found in this campaign");
    } else {
      const r = await tx.adGroup.updateMany({ where: { id: s.id, campaignId: o.campaignId }, data: { status: o.decision } });
      if (!r.count) throw new DomainError("not_found", "Ad group not found in this campaign");
    }
    await tx.adReviewAction.create({ data: { campaignId: o.campaignId, subjectType: s.type, subjectId: s.id, decision: o.decision, reasonCode: o.reasonCode ?? null, note: o.note ?? null, staffId: o.staffId } });
  });
  await invalidateSnapshot();
}

/**
 * Final decision on a campaign. Approve: every still-pending group, listing and keyword is approved too (items already
 * rejected stay rejected) and at least one listing must end up approved. Reject: the campaign returns to the seller with the reason.
 */
export async function decideCampaign(o: { campaignId: string; staffId: string; decision: "approved" | "rejected"; reasonCode?: ReasonCode; note?: string }) {
  if (o.decision === "rejected" && !o.reasonCode) throw new DomainError("validation", "A reason code is required to reject");
  await prisma.$transaction(async (tx) => {
    const c = await tx.adCampaign.findUnique({ where: { id: o.campaignId } });
    if (!c) throw new DomainError("not_found", "Campaign not found");
    if (c.status === "suspended") throw new DomainError("conflict", "Campaign is suspended");
    const now = new Date();
    if (o.decision === "approved") {
      await tx.adGroup.updateMany({ where: { campaignId: o.campaignId, status: "pending" }, data: { status: "approved" } });
      await tx.adGroupListing.updateMany({ where: { adGroup: { campaignId: o.campaignId }, reviewStatus: "pending" }, data: { reviewStatus: "approved" } });
      await tx.adKeyword.updateMany({ where: { adGroup: { campaignId: o.campaignId }, reviewStatus: "pending" }, data: { reviewStatus: "approved" } });
      const approved = await tx.adGroupListing.count({ where: { adGroup: { campaignId: o.campaignId, status: "approved" }, reviewStatus: "approved" } });
      if (!approved) throw new DomainError("validation", "Approve at least one listing before approving the campaign");
    }
    const to = o.decision === "approved" ? "approved" : "rejected";
    await tx.adCampaign.update({ where: { id: o.campaignId }, data: { status: to, reviewedAt: now, reviewedBy: o.staffId, rejectionReason: o.decision === "rejected" ? (o.note ?? o.reasonCode ?? null) : null } });
    await tx.adReviewAction.create({ data: { campaignId: o.campaignId, subjectType: "campaign", subjectId: o.campaignId, decision: o.decision, reasonCode: o.reasonCode ?? null, note: o.note ?? null, staffId: o.staffId } });
    await emit(tx, "AdCampaignReviewed", { type: "ad_campaign", id: o.campaignId }, {
      campaignId: o.campaignId, sellerBusinessId: c.sellerBusinessId, decision: o.decision, reviewedBy: o.staffId, ...(o.reasonCode ? { reasonCode: o.reasonCode } : {}), ...(o.note ? { note: o.note } : {}),
    });
    if (c.status !== to) await emit(tx, "AdCampaignStatusChanged", { type: "ad_campaign", id: o.campaignId }, { campaignId: o.campaignId, sellerBusinessId: c.sellerBusinessId, from: c.status, to, cause: "staff" });
  });
  await invalidateSnapshot();
}

/** Kill switch for one campaign (ads.suspend). The snapshot is dropped immediately, so serving stops within milliseconds. */
export async function suspendCampaign(campaignId: string, staffId: string, reason: string) {
  await prisma.$transaction(async (tx) => {
    const c = await tx.adCampaign.findUnique({ where: { id: campaignId } });
    if (!c) throw new DomainError("not_found", "Campaign not found");
    if (c.status === "suspended") return;
    await tx.adCampaign.update({ where: { id: campaignId }, data: { status: "suspended", haltReason: "suspended", rejectionReason: reason } });
    await tx.adReviewAction.create({ data: { campaignId, subjectType: "campaign", subjectId: campaignId, decision: "rejected", reasonCode: "other", note: `suspended: ${reason}`, staffId } });
    await emit(tx, "AdCampaignStatusChanged", { type: "ad_campaign", id: campaignId }, { campaignId, sellerBusinessId: c.sellerBusinessId, from: c.status, to: "suspended", cause: "staff" });
  });
  await invalidateSnapshot();
}

/** Suspends every live campaign of a business at once. */
export async function suspendBusinessAds(sellerBusinessId: string, staffId: string, reason: string): Promise<number> {
  const rows = await prisma.adCampaign.findMany({ where: { sellerBusinessId, status: { in: ["approved", "active", "exhausted", "paused", "pending_review"] } }, select: { id: true } });
  for (const r of rows) await suspendCampaign(r.id, staffId, reason);
  return rows.length;
}

export async function unsuspendCampaign(campaignId: string, staffId: string) {
  await prisma.$transaction(async (tx) => {
    const c = await tx.adCampaign.findUnique({ where: { id: campaignId } });
    if (!c || c.status !== "suspended") throw new DomainError("conflict", "Campaign is not suspended");
    await tx.adCampaign.update({ where: { id: campaignId }, data: { status: "approved", haltReason: null, rejectionReason: null } });
    await tx.adReviewAction.create({ data: { campaignId, subjectType: "campaign", subjectId: campaignId, decision: "approved", note: "unsuspended", staffId } });
    await emit(tx, "AdCampaignStatusChanged", { type: "ad_campaign", id: campaignId }, { campaignId, sellerBusinessId: c.sellerBusinessId, from: "suspended", to: "approved", cause: "staff" });
  });
  await invalidateSnapshot();
}

export async function listCampaignsForAdmin(opts: { status?: string; limit?: number } = {}) {
  const rows = await prisma.adCampaign.findMany({
    where: opts.status ? { status: opts.status as never } : {},
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limit ?? 100, 300),
  });
  return rows.map((c) => ({ id: c.id, name: c.name, status: c.status, haltReason: c.haltReason, sellerBusinessId: c.sellerBusinessId, dailyBudgetPaise: Number(c.dailyBudgetPaise), startsAt: c.startsAt.toISOString(), createdAt: c.createdAt.toISOString() }));
}

/** Campaigns with a high share of invalid/pending clicks in the window, for the invalid-traffic review queue (ads.fraud.review). */
export async function listInvalidTraffic(opts: { days?: number; minClicks?: number } = {}) {
  const since = new Date(Date.now() - (opts.days ?? 7) * 86_400_000);
  const rows = await prisma.adClick.groupBy({ by: ["campaignId", "validity"], where: { createdAt: { gte: since } }, _count: { _all: true } });
  const by = new Map<string, Record<string, number>>();
  for (const r of rows) by.set(r.campaignId, { ...(by.get(r.campaignId) ?? {}), [r.validity]: r._count._all });
  return [...by.entries()]
    .map(([campaignId, v]) => {
      const total = Object.values(v).reduce((a, b) => a + b, 0);
      const bad = (v.invalid ?? 0) + (v.pending ?? 0) + (v.self_click ?? 0);
      return { campaignId, total, valid: v.valid ?? 0, pending: v.pending ?? 0, invalid: v.invalid ?? 0, selfClicks: v.self_click ?? 0, badShare: total ? bad / total : 0 };
    })
    .filter((r) => r.total >= (opts.minClicks ?? 5))
    .sort((a, b) => b.badShare - a.badShare)
    .slice(0, 100);
}

export async function listClicksForReview(campaignId: string, limit = 100) {
  const rows = await prisma.adClick.findMany({ where: { campaignId, validity: { in: ["pending", "valid", "invalid"] } }, orderBy: { createdAt: "desc" }, take: Math.min(limit, 300) });
  return rows.map((c) => ({ id: c.id, listingId: c.listingId, validity: c.validity, invalidReason: c.invalidReason, chargedPaise: Number(c.chargedPaise), userAgentClass: c.userAgentClass, settled: !!c.settlementId, createdAt: c.createdAt.toISOString() }));
}
