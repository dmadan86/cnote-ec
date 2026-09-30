// The ad decision (design 5.5, 7.2). `getSponsoredSlots` is merged AFTER organic ranking and its cache:
// it reads the organic listing ids it is handed and never feeds anything back into them (ADR-024 rule 1).
//
// Hot path: in-process/Redis snapshot -> in-memory match and rank -> one Redis pipeline (kill, budget, frequency)
// -> cached public listing reads for the (at most 2) winners. No Postgres call on the happy path.
// Any error, or a run longer than 25 ms, returns ZERO ads: organic renders normally, ads are never on the critical path.
import { getPublicListingsByIds, type ListingView } from "@cnote/catalogue";
import { redis } from "@cnote/core";
import { getTrustProfiles, type TrustProfile } from "@cnote/identity";
import { randomUUID } from "node:crypto";
import { bufferImpressions, budgetKey, freqKey, killKey, totalKey } from "./budget";
import { isAdsEnabled } from "./config";
import { invalidateSnapshot, loadSnapshot, runEligibilitySweep, type AdCandidate, type AdSnapshot } from "./eligibility";
import { normaliseKeyword, paceDecision, placeSlots, rankScored, relevanceOf, slotAllowance, trustFactor, type PlacementSurface } from "./relevance";
import { hashVisitor, signClickToken } from "./tokens";
import { istDate, istDayFraction } from "./time";

export const DECISION_TIMEOUT_MS = 25;

export interface SponsoredSlotsInput {
  query: string;
  categoryId?: string | null;
  surface: "search" | "category" | "product_similar";
  organicListingIds: string[];
  limit?: number;
  /** first-party pseudonymous id (cnote_vid): frequency capping and rotation only */
  visitorId?: string | null;
  /** buyer location for geo-targeted campaigns (from the "Deliver to" pincode or the business profile) */
  buyerState?: string | null;
  buyerPincode?: string | null;
  /** product page: never show a seller's own ads on their own listing */
  excludeSellerBusinessId?: string | null;
  /** optional embedding similarity per listing id from search's index (refines relevance, never creates it) */
  similarity?: Record<string, number>;
  now?: Date;
  /** injectable for tests */
  random?: () => number;
  timeoutMs?: number;
}

export interface SponsoredSlot {
  slot: number;
  /** "top" = the labelled block above organic results; number = insert after that many organic results */
  after: "top" | number;
  /** always true: a slot can only be rendered as an ad */
  sponsored: true;
  label: "Sponsored";
  listing: ListingView;
  seller: TrustProfile;
  /** redirect URL that records the click, then 302s to the product */
  clickHref: string;
  clickToken: string;
  cpcPaise: number;
  relevance: number;
}

/** Score = relevance x trust. Exposed for the ranking-disclosure page and tests. */
export function scoreCandidate(relevance: number, c: Pick<AdCandidate, "trustScore" | "badgeActive">): number {
  return relevance * trustFactor(c);
}

function chainOf(id: string | null | undefined, parent: Record<string, string | null>): string[] {
  const out: string[] = [];
  let cur = id ?? null;
  while (cur && !out.includes(cur)) {
    out.push(cur);
    cur = parent[cur] ?? null;
  }
  return out;
}

function geoOk(c: AdCandidate, buyerState: string | null | undefined, buyerPincode: string | null | undefined): boolean {
  if (!c.states.length && !c.pincodePrefixes.length) return true;
  const stateHit = !!buyerState && c.states.some((s) => s.toLowerCase() === buyerState.toLowerCase());
  const pinHit = !!buyerPincode && c.pincodePrefixes.some((p) => buyerPincode.startsWith(p));
  // a campaign that restricts location needs a known buyer location that matches one of its targets
  return stateHit || pinHit;
}

export async function getSponsoredSlots(input: SponsoredSlotsInput): Promise<SponsoredSlot[]> {
  if (!isAdsEnabled()) return [];
  const ms = input.timeoutMs ?? DECISION_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      decide(input),
      new Promise<SponsoredSlot[]>((resolve) => {
        timer = setTimeout(() => resolve([]), ms);
        timer.unref?.();
      }),
    ]);
  } catch (err) {
    console.error("[ads] decision failed, serving organic only:", err instanceof Error ? err.message : err);
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function decide(input: SponsoredSlotsInput): Promise<SponsoredSlot[]> {
  const now = input.now ?? new Date();
  const snap = await loadSnapshot(now.getTime());
  if (!snap) {
    // cold start: rebuild in the background, serve organic-only this time
    void runEligibilitySweep().catch(() => undefined);
    return [];
  }
  const cfg = snap.config;
  const allowance = slotAllowance(input.surface as PlacementSurface, input.organicListingIds.length, input.limit, cfg);
  if (allowance <= 0) return [];

  const kills = await redis.mget(killKey("all"), killKey(input.surface));
  if (kills.some((k) => k === "1")) return [];

  const query = normaliseKeyword(input.query ?? "");
  const requestChain = chainOf(input.categoryId, snap.categoryParent);
  const organic = new Set(input.organicListingIds);
  const t = now.getTime();

  // 1. match + relevance + trust in memory
  const scored: { id: string; score: number; relevance: number; c: AdCandidate; cpc: number }[] = [];
  for (const c of snap.candidates) {
    if (!c.surfaces.includes(input.surface) || c.cpc[input.surface] === undefined) continue;
    if (c.startsAt > t || (c.endsAt !== null && c.endsAt <= t)) continue;
    if (organic.has(c.listingId)) continue; // never duplicate an organic result on the page
    if (input.excludeSellerBusinessId && c.sellerBusinessId === input.excludeSellerBusinessId) continue;
    if (c.trustScore < cfg.trustFloor || c.verificationTier < cfg.minVerificationTier) continue; // re-checked at decision time
    if (!geoOk(c, input.buyerState, input.buyerPincode)) continue;
    const relevance = relevanceOf({
      query,
      requestChain,
      keywords: c.keywords,
      negatives: c.negatives,
      title: c.title,
      listingChain: c.listingChain,
      targetCategories: c.targetCategories,
      similarity: input.similarity?.[c.listingId],
    });
    if (relevance < cfg.minRelevance) continue;
    scored.push({ id: c.id, score: scoreCandidate(relevance, c), relevance, c, cpc: c.cpc[input.surface]! });
  }
  if (!scored.length) return [];

  // 2. rank by quality; near-ties rotate by (visitor | hour); one ad per seller and per listing
  const seed = `${input.visitorId ?? "anon"}|${Math.floor(t / 3_600_000)}`;
  const ranked = rankScored(scored, cfg.nearTieRatio, seed);
  const pool: typeof ranked = [];
  const sellers = new Set<string>();
  const listingsSeen = new Set<string>();
  for (const r of ranked) {
    if (sellers.has(r.c.sellerBusinessId) || listingsSeen.has(r.c.listingId)) continue;
    sellers.add(r.c.sellerBusinessId);
    listingsSeen.add(r.c.listingId);
    pool.push(r);
    if (pool.length >= allowance * 4) break;
  }

  // 3. budget, pacing and frequency in one round trip
  const visitor = input.visitorId ? hashVisitor(input.visitorId, now) : null;
  const date = istDate(now);
  const pipe = redis.pipeline();
  for (const p of pool) pipe.get(budgetKey(p.c.campaignId, date)).get(totalKey(p.c.campaignId));
  if (visitor) for (const p of pool) pipe.get(freqKey(visitor, p.c.listingId));
  const res = (await pipe.exec()) ?? [];
  const rand = input.random ?? Math.random;
  const dayFraction = istDayFraction(now);
  const chosen: typeof pool = [];
  const lostBudget: { campaignId: string; listingId: string; categoryId: string | null; surface: string }[] = [];
  const lostQuality: typeof lostBudget = [];
  pool.forEach((p, i) => {
    const spent = Number(res[i * 2]?.[1] ?? 0);
    const total = Number(res[i * 2 + 1]?.[1] ?? 0);
    const freq = visitor ? Number(res[pool.length * 2 + i]?.[1] ?? 0) : 0;
    const ref = { campaignId: p.c.campaignId, listingId: p.c.listingId, categoryId: p.c.categoryId, surface: input.surface };
    if (visitor && freq >= cfg.frequencyCap) return void lostQuality.push(ref);
    if (p.c.totalBudgetPaise !== null && total + p.cpc > p.c.totalBudgetPaise) return void lostBudget.push(ref);
    const pace = paceDecision({ spentPaise: spent, dailyBudgetPaise: p.c.dailyBudgetPaise, cpcPaise: p.cpc, dayFraction, paceMultiplier: cfg.paceMultiplier, random: rand() });
    if (!pace.allowed) return void lostBudget.push(ref);
    if (chosen.length < allowance) chosen.push(p);
    else lostQuality.push(ref);
  });
  if (!chosen.length) {
    if (lostBudget.length || lostQuality.length) await bufferImpressions({ at: now, served: [], lostBudget, lostQuality, frequency: [] }).catch(() => undefined);
    return [];
  }

  // 4. public reads: also drops a winner whose listing was unpublished after the snapshot was built
  const [listings, profiles] = await Promise.all([getPublicListingsByIds(chosen.map((c) => c.c.listingId)), getTrustProfiles(chosen.map((c) => c.c.sellerBusinessId))]);
  const byId = new Map(listings.map((l) => [l.id, l]));
  const live = chosen.filter((p) => byId.has(p.c.listingId) && profiles.has(p.c.sellerBusinessId));
  const placed = placeSlots(live.length, cfg.perOrganicResults);
  const slots: SponsoredSlot[] = live.map((p, i) => {
    const slot = placed[i]!;
    const token = signClickToken({ t: randomUUID(), c: p.c.campaignId, g: p.c.adGroupId, l: p.c.listingId, s: p.c.sellerBusinessId, f: input.surface, n: slot.slot, p: p.cpc, q: query || null, i: t });
    return {
      slot: slot.slot,
      after: slot.after,
      sponsored: true as const,
      label: "Sponsored" as const,
      listing: byId.get(p.c.listingId)!,
      seller: profiles.get(p.c.sellerBusinessId)!,
      clickHref: `/ad/${token}`,
      clickToken: token,
      cpcPaise: p.cpc,
      relevance: Number(p.relevance.toFixed(4)),
    };
  });
  await bufferImpressions({
    at: now,
    served: live.map((p, i) => ({ campaignId: p.c.campaignId, listingId: p.c.listingId, categoryId: p.c.categoryId, surface: input.surface, slot: placed[i]!.slot })),
    lostBudget,
    lostQuality,
    frequency: visitor ? live.map((p) => ({ visitor, listingId: p.c.listingId, windowSeconds: cfg.frequencyWindowHours * 3600 })) : [],
  }).catch(() => undefined);
  return slots;
}

export type { AdSnapshot };
export { invalidateSnapshot };
