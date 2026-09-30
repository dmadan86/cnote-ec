// Seller campaign management (design 5.1, 5.2): campaigns -> ad groups -> listings + keywords, then submit for staff review.
// Every function takes the seller's businessId and verifies ownership; nothing here can touch another seller's campaign.
import { getCategoryById, getListing } from "@cnote/catalogue";
import { DomainError, emit } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { z } from "zod";
import { getAdsConfig } from "./config";
import { invalidateSnapshot } from "./eligibility";
import { normaliseKeyword } from "./relevance";

const SELLER_SURFACES = ["search", "category", "product_similar"] as const;
const PIN3 = /^\d{3}$/;

export const campaignInput = z.object({
  name: z.string().trim().min(2).max(120),
  dailyBudgetPaise: z.number().int().positive().max(100_000_000),
  totalBudgetPaise: z.number().int().positive().max(1_000_000_000).nullable().optional(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().nullable().optional(),
});
export type CampaignInput = z.input<typeof campaignInput>;

export const adGroupInput = z.object({
  name: z.string().trim().min(2).max(120),
  surfaces: z.array(z.enum(SELLER_SURFACES)).min(1).max(3).default(["search", "category"]),
  categoryIds: z.array(z.uuid()).max(20).default([]),
  states: z.array(z.string().trim().min(2).max(60)).max(40).default([]),
  pincodePrefixes: z.array(z.string().regex(PIN3, "Use the first 3 digits of a pincode")).max(100).default([]),
});
export type AdGroupInput = z.input<typeof adGroupInput>;

export const keywordInput = z.object({
  text: z.string().trim().min(2).max(80),
  matchType: z.enum(["exact", "phrase", "broad"]).default("phrase"),
  negative: z.boolean().default(false),
});

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw new DomainError("validation", r.error.issues[0]?.message ?? "Invalid input", r.error.issues);
  return r.data;
}

async function ownedCampaign(sellerBusinessId: string, campaignId: string) {
  const c = await prisma.adCampaign.findUnique({ where: { id: campaignId } });
  if (!c) throw new DomainError("not_found", "Campaign not found");
  if (c.sellerBusinessId !== sellerBusinessId) throw new DomainError("forbidden", "Not your campaign");
  return c;
}

async function ownedGroup(sellerBusinessId: string, adGroupId: string) {
  const g = await prisma.adGroup.findUnique({ where: { id: adGroupId }, include: { campaign: true } });
  if (!g) throw new DomainError("not_found", "Ad group not found");
  if (g.campaign.sellerBusinessId !== sellerBusinessId) throw new DomainError("forbidden", "Not your campaign");
  return g;
}

const EDITABLE = ["draft", "rejected", "paused", "approved", "active", "exhausted", "pending_review"] as const;
function assertEditable(status: string) {
  if (!(EDITABLE as readonly string[]).includes(status)) throw new DomainError("conflict", `A ${status} campaign cannot be edited`);
}

async function checkBudget(daily: number, total: number | null | undefined, startsAt: Date, endsAt: Date | null | undefined) {
  const cfg = await getAdsConfig();
  if (daily < cfg.minDailyBudgetPaise) throw new DomainError("validation", `Daily budget must be at least Rs ${cfg.minDailyBudgetPaise / 100}`);
  if (total != null && total < daily) throw new DomainError("validation", "Total budget cannot be below the daily budget");
  if (endsAt && endsAt <= startsAt) throw new DomainError("validation", "End date must be after the start date");
}

export async function createCampaign(sellerBusinessId: string, input: CampaignInput, opts: { createdByStaffId?: string } = {}) {
  const d = parse(campaignInput, input);
  await checkBudget(d.dailyBudgetPaise, d.totalBudgetPaise, d.startsAt, d.endsAt);
  const row = await prisma.adCampaign.create({
    data: {
      sellerBusinessId,
      name: d.name,
      dailyBudgetPaise: BigInt(d.dailyBudgetPaise),
      totalBudgetPaise: d.totalBudgetPaise == null ? null : BigInt(d.totalBudgetPaise),
      startsAt: d.startsAt,
      endsAt: d.endsAt ?? null,
      createdByStaffId: opts.createdByStaffId ?? null,
    },
  });
  return { id: row.id };
}

/** A budget more than doubling, or a schedule change on a live campaign, returns it to review (design 5.9); decreases never do. */
export async function updateCampaign(sellerBusinessId: string, campaignId: string, patch: Partial<CampaignInput>) {
  const c = await ownedCampaign(sellerBusinessId, campaignId);
  assertEditable(c.status);
  const d = parse(campaignInput.partial(), patch);
  const daily = d.dailyBudgetPaise ?? Number(c.dailyBudgetPaise);
  const total = d.totalBudgetPaise === undefined ? (c.totalBudgetPaise === null ? null : Number(c.totalBudgetPaise)) : d.totalBudgetPaise;
  const startsAt = d.startsAt ?? c.startsAt;
  const endsAt = d.endsAt === undefined ? c.endsAt : d.endsAt;
  await checkBudget(daily, total, startsAt, endsAt);
  const live = ["approved", "active", "exhausted", "paused"].includes(c.status);
  const material = live && daily > Number(c.dailyBudgetPaise) * 2;
  await prisma.adCampaign.update({
    where: { id: campaignId },
    data: { name: d.name ?? c.name, dailyBudgetPaise: BigInt(daily), totalBudgetPaise: total === null ? null : BigInt(total), startsAt, endsAt, ...(material ? { status: "pending_review", submittedAt: new Date(), reviewedAt: null } : {}) },
  });
  if (live) await invalidateSnapshot();
  return { returnedToReview: material };
}

export async function addAdGroup(sellerBusinessId: string, campaignId: string, input: AdGroupInput) {
  const c = await ownedCampaign(sellerBusinessId, campaignId);
  assertEditable(c.status);
  const d = parse(adGroupInput, input);
  for (const id of d.categoryIds) if (!(await getCategoryById(id))) throw new DomainError("validation", "Unknown category");
  const g = await prisma.adGroup.create({ data: { campaignId, name: d.name, surfaces: d.surfaces, categoryIds: d.categoryIds, states: d.states, pincodePrefixes: d.pincodePrefixes } });
  return { id: g.id };
}

/** Targeting edits return the group to review (a category or location change is material). */
export async function updateAdGroup(sellerBusinessId: string, adGroupId: string, patch: Partial<AdGroupInput>) {
  const g = await ownedGroup(sellerBusinessId, adGroupId);
  assertEditable(g.campaign.status);
  const d = parse(adGroupInput.partial(), patch);
  if (d.categoryIds) for (const id of d.categoryIds) if (!(await getCategoryById(id))) throw new DomainError("validation", "Unknown category");
  const targeting = d.categoryIds !== undefined || d.states !== undefined || d.pincodePrefixes !== undefined;
  await prisma.adGroup.update({ where: { id: adGroupId }, data: { ...d, ...(targeting && g.status === "approved" ? { status: "pending" } : {}) } });
  await invalidateSnapshot();
}

export async function addListingToGroup(sellerBusinessId: string, adGroupId: string, listingId: string) {
  const g = await ownedGroup(sellerBusinessId, adGroupId);
  assertEditable(g.campaign.status);
  const listing = await getListing(listingId);
  if (!listing) throw new DomainError("not_found", "Listing not found");
  if (listing.sellerBusinessId !== sellerBusinessId) throw new DomainError("forbidden", "You can only advertise your own listings");
  const row = await prisma.adGroupListing.upsert({ where: { adGroupId_listingId: { adGroupId, listingId } }, create: { adGroupId, listingId }, update: {} });
  return { id: row.id };
}

export async function removeListingFromGroup(sellerBusinessId: string, adGroupId: string, listingId: string) {
  await ownedGroup(sellerBusinessId, adGroupId);
  await prisma.adGroupListing.deleteMany({ where: { adGroupId, listingId } });
  await invalidateSnapshot();
}

export async function addKeyword(sellerBusinessId: string, adGroupId: string, input: z.input<typeof keywordInput>) {
  const g = await ownedGroup(sellerBusinessId, adGroupId);
  assertEditable(g.campaign.status);
  const d = parse(keywordInput, input);
  const normalised = normaliseKeyword(d.text);
  if (normalised.length < 2) throw new DomainError("validation", "Keyword is too short");
  const row = await prisma.adKeyword.upsert({
    where: { adGroupId_normalised_matchType_negative: { adGroupId, normalised, matchType: d.matchType, negative: d.negative } },
    create: { adGroupId, text: d.text, normalised, matchType: d.matchType, negative: d.negative },
    update: {},
  });
  return { id: row.id };
}

export async function removeKeyword(sellerBusinessId: string, keywordId: string) {
  const k = await prisma.adKeyword.findUnique({ where: { id: keywordId } });
  if (!k) throw new DomainError("not_found", "Keyword not found");
  await ownedGroup(sellerBusinessId, k.adGroupId);
  await prisma.adKeyword.delete({ where: { id: keywordId } });
  await invalidateSnapshot();
}

/** draft/rejected -> pending_review. Needs at least one ad group with a listing and (for search) a keyword or category. */
export async function submitCampaign(sellerBusinessId: string, campaignId: string) {
  const c = await ownedCampaign(sellerBusinessId, campaignId);
  if (c.status !== "draft" && c.status !== "rejected") throw new DomainError("conflict", "Only a draft or rejected campaign can be submitted");
  const groups = await prisma.adGroup.findMany({ where: { campaignId }, include: { listings: true, keywords: true } });
  if (!groups.length || !groups.some((g) => g.listings.length)) throw new DomainError("validation", "Add an ad group with at least one product before submitting");
  if (groups.some((g) => g.listings.length && !g.keywords.some((k) => !k.negative) && !g.categoryIds.length)) throw new DomainError("validation", "Each ad group needs at least one keyword or category");
  await prisma.$transaction(async (tx) => {
    await tx.adCampaign.update({ where: { id: campaignId }, data: { status: "pending_review", submittedAt: new Date(), rejectionReason: null } });
    await tx.adGroup.updateMany({ where: { campaignId, status: "rejected" }, data: { status: "pending" } });
    await emit(tx, "AdCampaignSubmitted", { type: "ad_campaign", id: campaignId }, { campaignId, sellerBusinessId, objective: c.objective, dailyBudgetPaise: Number(c.dailyBudgetPaise), createdByStaff: !!c.createdByStaffId });
  });
}

async function transition(sellerBusinessId: string, campaignId: string, from: string[], to: "paused" | "approved" | "ended") {
  const c = await ownedCampaign(sellerBusinessId, campaignId);
  if (!from.includes(c.status)) throw new DomainError("conflict", `Cannot change a ${c.status} campaign this way`);
  await prisma.$transaction(async (tx) => {
    // compare-and-set: the sweep (or staff) may have moved the campaign since we read it
    const r = await tx.adCampaign.updateMany({ where: { id: campaignId, status: c.status }, data: { status: to, haltReason: null } });
    if (r.count === 0) throw new DomainError("conflict", "The campaign changed just now. Refresh and try again.");
    await emit(tx, "AdCampaignStatusChanged", { type: "ad_campaign", id: campaignId }, { campaignId, sellerBusinessId, from: c.status, to, cause: "seller" });
  });
  await invalidateSnapshot();
}

export const pauseCampaign = (seller: string, id: string) => transition(seller, id, ["approved", "active", "exhausted"], "paused");
/** Resuming re-enters `approved`; the sweep flips it to active when funded and eligible. */
export const resumeCampaign = (seller: string, id: string) => transition(seller, id, ["paused"], "approved");
export const endCampaign = (seller: string, id: string) => transition(seller, id, ["draft", "approved", "active", "exhausted", "paused", "rejected"], "ended");

export interface CampaignSummary {
  id: string;
  name: string;
  status: string;
  haltReason: string | null;
  dailyBudgetPaise: number;
  totalBudgetPaise: number | null;
  startsAt: string;
  endsAt: string | null;
  rejectionReason: string | null;
  groups: number;
  listings: number;
}

export async function listCampaigns(sellerBusinessId: string): Promise<CampaignSummary[]> {
  const rows = await prisma.adCampaign.findMany({ where: { sellerBusinessId }, orderBy: { createdAt: "desc" }, take: 200, include: { adGroups: { include: { _count: { select: { listings: true } } } } } });
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    haltReason: c.haltReason,
    dailyBudgetPaise: Number(c.dailyBudgetPaise),
    totalBudgetPaise: c.totalBudgetPaise === null ? null : Number(c.totalBudgetPaise),
    startsAt: c.startsAt.toISOString(),
    endsAt: c.endsAt?.toISOString() ?? null,
    rejectionReason: c.rejectionReason,
    groups: c.adGroups.length,
    listings: c.adGroups.reduce((s, g) => s + g._count.listings, 0),
  }));
}

export type CampaignDetail = Prisma.AdCampaignGetPayload<{ include: { adGroups: { include: { listings: true; keywords: true } } } }>;

export async function getCampaign(sellerBusinessId: string, campaignId: string): Promise<CampaignDetail> {
  await ownedCampaign(sellerBusinessId, campaignId);
  return prisma.adCampaign.findUniqueOrThrow({ where: { id: campaignId }, include: { adGroups: { orderBy: { createdAt: "asc" }, include: { listings: true, keywords: { orderBy: { createdAt: "asc" } } } } } });
}
