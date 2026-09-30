// Eligibility sweep + candidate snapshot (design 5.3, 7.2).
// The serving path (decision.ts) never touches Postgres: it reads the snapshot this sweep writes to Redis
// (and a 15 s in-process copy). Any doubt at sweep time means "not eligible": we would rather show no ad.
import { getPublicListingsByIds, listCategories, type ListingView } from "@cnote/catalogue";
import { emit, redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { getAdWalletBalance } from "@cnote/billing";
import { getTrustProfiles, type TrustProfile } from "@cnote/identity";
import { getSpentToday } from "./budget";
import { getAdsConfig, isAdsEnabled, type AdsConfig } from "./config";
import { categoryChains, loadRateRows, resolveRate } from "./rate-card";
import type { CandidateKeyword } from "./relevance";
import { istDate } from "./time";

export const SNAPSHOT_KEY = "ads:snap:v1";
const LOCK_KEY = "ads:sweep:lock";
const LOCAL_TTL_MS = 15_000;

export interface AdCandidate {
  id: string; // AdGroupListing id
  campaignId: string;
  adGroupId: string;
  listingId: string;
  sellerBusinessId: string;
  categoryId: string;
  listingChain: string[];
  title: string;
  surfaces: string[];
  cpc: Record<string, number>;
  keywords: CandidateKeyword[];
  negatives: string[];
  targetCategories: string[];
  states: string[];
  pincodePrefixes: string[];
  dailyBudgetPaise: number;
  totalBudgetPaise: number | null;
  startsAt: number;
  endsAt: number | null;
  trustScore: number;
  badgeActive: boolean;
  verificationTier: number;
  sellerState: string | null;
}

export interface AdSnapshot {
  v: 1;
  builtAt: number;
  config: AdsConfig;
  categoryParent: Record<string, string | null>;
  candidates: AdCandidate[];
}

export type IneligibleReason =
  | "seller_unknown" | "tier_below_min" | "trust_below_floor" | "listing_unpublished" | "no_approved_image" | "no_price" | "category_prohibited" | "no_rate_card";

/** Pure verdict, checked in this order so the recorded reason is the first thing a seller can fix. */
export function judgeEligibility(i: {
  trust: Pick<TrustProfile, "trustScore" | "verificationTier"> | undefined;
  listing: Pick<ListingView, "pricePaise" | "imageUrls" | "status" | "moderationStatus"> | undefined;
  categoryProhibited: boolean;
  hasRate: boolean;
  cfg: Pick<AdsConfig, "trustFloor" | "minVerificationTier">;
}): { eligible: true } | { eligible: false; reason: IneligibleReason } {
  if (!i.trust) return { eligible: false, reason: "seller_unknown" };
  if (i.trust.verificationTier < i.cfg.minVerificationTier) return { eligible: false, reason: "tier_below_min" };
  if (i.trust.trustScore < i.cfg.trustFloor) return { eligible: false, reason: "trust_below_floor" };
  // public reads come from the LIVE database, which only holds published + approved projections
  if (!i.listing || i.listing.status !== "published" || i.listing.moderationStatus !== "approved") return { eligible: false, reason: "listing_unpublished" };
  if (!i.listing.imageUrls?.length) return { eligible: false, reason: "no_approved_image" };
  if (i.listing.pricePaise == null) return { eligible: false, reason: "no_price" };
  if (i.categoryProhibited) return { eligible: false, reason: "category_prohibited" };
  if (!i.hasRate) return { eligible: false, reason: "no_rate_card" };
  return { eligible: true };
}

export interface SweepResult {
  campaigns: number;
  candidates: number;
  ineligible: number;
  halted: number;
}

const SERVING = ["approved", "active", "exhausted"] as const;

/** Rebuilds verdicts, campaign halt state and the Redis snapshot. Returns null when another worker holds the lock. */
export async function runEligibilitySweep(now = new Date(), opts: { wait?: boolean } = {}): Promise<SweepResult | null> {
  let locked = (await redis.set(LOCK_KEY, "1", "EX", 30, "NX")) === "OK";
  for (let i = 0; !locked && opts.wait && i < 100; i++) {
    await new Promise((r) => setTimeout(r, 50));
    locked = (await redis.set(LOCK_KEY, "1", "EX", 30, "NX")) === "OK";
  }
  if (!locked) return null;
  try {
    return await sweep(now);
  } finally {
    await redis.del(LOCK_KEY);
  }
}

async function sweep(now: Date): Promise<SweepResult> {
  const cfg = await getAdsConfig(now.getTime());
  // campaigns whose schedule has ended stop serving for good
  const overdue = await prisma.adCampaign.findMany({ where: { status: { in: [...SERVING] }, endsAt: { lte: now } } });
  for (const c of overdue) {
    await prisma.$transaction(async (tx) => {
      await tx.adCampaign.updateMany({ where: { id: c.id }, data: { status: "ended", haltReason: null } });
      await emit(tx, "AdCampaignStatusChanged", { type: "ad_campaign", id: c.id }, { campaignId: c.id, sellerBusinessId: c.sellerBusinessId, from: c.status, to: "ended", cause: "schedule" });
    });
  }
  const campaigns = await prisma.adCampaign.findMany({
    where: { status: { in: [...SERVING] }, startsAt: { lte: now } },
    include: { adGroups: { where: { status: "approved" }, include: { listings: { where: { reviewStatus: "approved" } }, keywords: { where: { reviewStatus: "approved" } } } } },
  });
  const listingIds = [...new Set(campaigns.flatMap((c) => c.adGroups.flatMap((g) => g.listings.map((l) => l.listingId))))];
  const sellerIds = [...new Set(campaigns.map((c) => c.sellerBusinessId))];
  const [listings, trust, cats, chains, rates, spent] = await Promise.all([
    getPublicListingsByIds(listingIds),
    getTrustProfiles(sellerIds),
    listCategories(),
    categoryChains(),
    loadRateRows(),
    getSpentToday(campaigns.map((c) => c.id), now),
  ]);
  const listingById = new Map(listings.map((l) => [l.id, l]));
  const prohibited = new Set(cats.filter((c) => c.prohibited).map((c) => c.id));
  const balances = new Map<string, number>();
  for (const id of sellerIds) balances.set(id, await getAdWalletBalance(id, now));

  const candidates: AdCandidate[] = [];
  let ineligible = 0;
  let halted = 0;
  for (const c of campaigns) {
    let eligibleCount = 0;
    const built: AdCandidate[] = [];
    for (const g of c.adGroups) {
      const kws = g.keywords.filter((k) => !k.negative);
      const negatives = g.keywords.filter((k) => k.negative).map((k) => k.normalised);
      for (const al of g.listings) {
        const listing = listingById.get(al.listingId);
        const chain = listing ? (chains.get(listing.category.id) ?? [listing.category.id]) : [];
        const cpc: Record<string, number> = {};
        for (const s of g.surfaces) {
          const r = resolveRate(rates, chain, s, now);
          if (r) cpc[s] = r.cpcPaise;
        }
        const verdict = judgeEligibility({
          trust: trust.get(c.sellerBusinessId),
          listing,
          categoryProhibited: chain.some((id) => prohibited.has(id)),
          hasRate: Object.keys(cpc).length > 0,
          cfg,
        });
        const reason = verdict.eligible ? null : verdict.reason;
        if (al.eligible !== verdict.eligible || al.ineligibleReason !== reason) {
          await prisma.$transaction(async (tx) => {
            await tx.adGroupListing.updateMany({ where: { id: al.id }, data: { eligible: verdict.eligible, ineligibleReason: reason } });
            if (!verdict.eligible && al.eligible) {
              await emit(tx, "AdIneligible", { type: "listing", id: al.listingId }, { listingId: al.listingId, sellerBusinessId: c.sellerBusinessId, campaignId: c.id, reason: verdict.reason });
            }
          });
        }
        if (!verdict.eligible || !listing) {
          ineligible++;
          continue;
        }
        eligibleCount++;
        const t = trust.get(c.sellerBusinessId)!;
        built.push({
          id: al.id,
          campaignId: c.id,
          adGroupId: g.id,
          listingId: al.listingId,
          sellerBusinessId: c.sellerBusinessId,
          categoryId: listing.category.id,
          listingChain: chain,
          title: listing.title,
          surfaces: g.surfaces.filter((s) => s in cpc),
          cpc,
          keywords: kws.map((k) => ({ n: k.normalised, m: k.matchType })),
          negatives,
          targetCategories: g.categoryIds,
          states: g.states,
          pincodePrefixes: g.pincodePrefixes,
          dailyBudgetPaise: Number(c.dailyBudgetPaise),
          totalBudgetPaise: c.totalBudgetPaise === null ? null : Number(c.totalBudgetPaise),
          startsAt: c.startsAt.getTime(),
          endsAt: c.endsAt?.getTime() ?? null,
          trustScore: t.trustScore,
          badgeActive: t.badgeActive,
          verificationTier: t.verificationTier,
          sellerState: t.state,
        });
      }
    }
    const sp = spent.get(c.id) ?? { day: 0, total: 0 };
    const minCpc = Math.min(...(built.length ? built.flatMap((b) => Object.values(b.cpc)) : [Number.MAX_SAFE_INTEGER]));
    const budgetHit = built.length > 0 && (sp.day + minCpc > Number(c.dailyBudgetPaise) || (c.totalBudgetPaise !== null && sp.total + minCpc > Number(c.totalBudgetPaise)));
    const balance = balances.get(c.sellerBusinessId) ?? 0;
    const halt: "wallet" | "eligibility" | "budget" | null = balance <= 0 ? "wallet" : eligibleCount === 0 ? "eligibility" : budgetHit ? "budget" : null;
    const status = halt === "budget" ? "exhausted" : halt ? "approved" : "active";
    if (c.status !== status || c.haltReason !== halt) {
      await prisma.$transaction(async (tx) => {
        await tx.adCampaign.updateMany({ where: { id: c.id }, data: { status, haltReason: halt } });
        if (c.status !== status) {
          const cause = halt === "wallet" ? "wallet" : halt === "eligibility" ? "eligibility" : halt === "budget" ? "budget" : "schedule";
          await emit(tx, "AdCampaignStatusChanged", { type: "ad_campaign", id: c.id }, { campaignId: c.id, sellerBusinessId: c.sellerBusinessId, from: c.status, to: status, cause });
        }
        if (halt === "budget" && c.status !== "exhausted") {
          await emit(tx, "AdBudgetExhausted", { type: "ad_campaign", id: c.id }, { campaignId: c.id, sellerBusinessId: c.sellerBusinessId, istDate: istDate(now), spentPaise: sp.day, dailyBudgetPaise: Number(c.dailyBudgetPaise) });
        }
      });
    }
    // an exhausted (budget) campaign stays in the snapshot: the per-request counter check decides, and it resumes at IST midnight
    if (halt === null || halt === "budget") {
      if (halt === "budget") halted++;
      candidates.push(...built);
    } else halted++;
  }

  const categoryParent: Record<string, string | null> = Object.fromEntries(cats.map((c) => [c.id, c.parentId]));
  const snap: AdSnapshot = { v: 1, builtAt: now.getTime(), config: cfg, categoryParent, candidates };
  await redis.set(SNAPSHOT_KEY, JSON.stringify(snap), "EX", cfg.snapshotTtlSeconds);
  local = { at: Date.now(), snap };
  return { campaigns: campaigns.length, candidates: candidates.length, ineligible, halted };
}

let local: { at: number; snap: AdSnapshot } | null = null;

/** Snapshot for the serving path: 15 s in-process, then Redis. Returns null (and never queries Postgres) when absent. */
export async function loadSnapshot(now = Date.now()): Promise<AdSnapshot | null> {
  if (local && now - local.at < LOCAL_TTL_MS) return local.snap;
  const raw = await redis.get(SNAPSHOT_KEY);
  if (!raw) return null;
  const snap = JSON.parse(raw) as AdSnapshot;
  local = { at: now, snap };
  return snap;
}

/** Drops the snapshot everywhere so a suspension or moderation change stops serving immediately, then rebuilds in the background. */
export async function invalidateSnapshot(opts: { rebuild?: boolean } = {}): Promise<void> {
  local = null;
  await redis.del(SNAPSHOT_KEY);
  if (opts.rebuild !== false && isAdsEnabled()) {
    const p: Promise<unknown> = runEligibilitySweep()
      .catch((e) => console.error("[ads] sweep failed:", e instanceof Error ? e.message : e))
      .finally(() => background.delete(p));
    background.add(p);
  }
}

const background = new Set<Promise<unknown>>();

/** Lets callers (tests, graceful shutdown) wait for rebuilds started by invalidateSnapshot. */
export async function waitForBackgroundSweeps(): Promise<void> {
  while (background.size) await Promise.allSettled([...background]);
}

export function resetSnapshotCacheForTests(): void {
  local = null;
}
