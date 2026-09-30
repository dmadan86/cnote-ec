// Pure ranking and slot rules for sponsored placements (ADR-024). No I/O.
//   score = relevance x trustFactor   (Phase 1.5: price is fixed, so it never enters the score; ADR-009 / P2 / P3)
// Nothing here is imported by organic search, and plan tier / wallet balance / spend are not inputs.
import { normaliseQuery } from "@cnote/search";
import type { AdsConfig } from "./config";

export type MatchType = "exact" | "phrase" | "broad";

export interface CandidateKeyword {
  n: string; // normalised text
  m: MatchType;
}

export interface RelevanceInput {
  /** normalised query text ("" for a pure category browse) */
  query: string;
  /** requested category and its ancestor chain (self first); [] when none */
  requestChain: string[];
  keywords: CandidateKeyword[];
  negatives: string[];
  title: string;
  /** listing category chain (self first) */
  listingChain: string[];
  /** ad group category targets (leaf or parent); empty = no restriction */
  targetCategories: string[];
  /** optional embedding cosine similarity from search's index (0..1) */
  similarity?: number;
}

const tokens = (s: string): string[] => s.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1);
/** cheap plural fold so "boxes"/"box" and "bags"/"bag" overlap */
const stem = (t: string) => (t.length > 3 && t.endsWith("es") ? t.slice(0, -2) : t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t);
const stems = (s: string) => new Set(tokens(s).map(stem));

export function normaliseKeyword(text: string): string {
  return normaliseQuery(text).text.trim();
}

/** "0.6 to 1.03 trust weighting": the SAME formula organic ranking uses (packages/search fusion.ts; parity is tested). */
export function trustFactor(p: { trustScore: number; badgeActive: boolean }): number {
  const t = Math.min(100, Math.max(0, p.trustScore));
  return 0.6 + 0.4 * (t / 100) + (p.badgeActive ? 0.03 : 0);
}

function phraseContains(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const h = ` ${tokens(haystack).map(stem).join(" ")} `;
  const n = ` ${tokens(needle).map(stem).join(" ")} `;
  return n.trim().length > 0 && h.includes(n);
}

export function keywordRelevance(query: string, kw: CandidateKeyword): number {
  if (!query) return 0;
  const q = tokens(query).map(stem).join(" ");
  const k = tokens(kw.n).map(stem).join(" ");
  if (!k) return 0;
  if (kw.m === "exact") return q === k ? 1 : 0;
  if (kw.m === "phrase") return phraseContains(query, kw.n) ? (q === k ? 1 : 0.8) : 0;
  const qs = new Set(q.split(" "));
  const ks = k.split(" ");
  const overlap = ks.filter((t) => qs.has(t)).length / ks.length;
  return overlap * 0.5;
}

export function isNegativeMatch(query: string, negatives: string[]): boolean {
  return negatives.some((n) => phraseContains(query, n));
}

/** Fraction of the query's terms present in the listing title, scaled to at most 0.6. */
export function titleRelevance(query: string, title: string): number {
  const q = stems(query);
  if (!q.size) return 0;
  const t = stems(title);
  let hit = 0;
  for (const w of q) if (t.has(w)) hit++;
  return (hit / q.size) * 0.6;
}

export function categoryTargetOk(i: Pick<RelevanceInput, "requestChain" | "listingChain" | "targetCategories">): boolean {
  if (!i.targetCategories.length) return true;
  return i.targetCategories.some((t) => i.listingChain.includes(t) || i.requestChain.includes(t));
}

/**
 * Relevance in [0,1]. 0 means "not eligible for this request". Needs at least one real match signal (keyword, title or
 * category); the embedding similarity can only refine a match, never create one, so nothing irrelevant can be bought in.
 */
export function relevanceOf(i: RelevanceInput): number {
  if (isNegativeMatch(i.query, i.negatives)) return 0;
  if (!categoryTargetOk(i)) return 0;
  const kw = Math.max(0, ...i.keywords.map((k) => keywordRelevance(i.query, k)));
  const title = titleRelevance(i.query, i.title);
  const inRequestCategory = i.requestChain.length > 0 && i.listingChain.includes(i.requestChain[0]!);
  const cat = inRequestCategory ? 0.4 : 0;
  const base = Math.max(kw, title, cat);
  if (base <= 0) return 0;
  const sim = i.similarity === undefined ? undefined : Math.min(1, Math.max(0, i.similarity));
  const r = sim === undefined ? base : 0.75 * base + 0.25 * sim;
  return Math.min(1, r);
}

/** Deterministic 0..1 hash for rotation among near-ties. */
export function rotationHash(seed: string, id: string): number {
  let h = 2166136261;
  for (const c of `${seed}|${id}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h / 4294967296;
}

/**
 * Order by score; scores within `nearTieRatio` of each other form a tie band that is rotated by `seed`
 * (so equal-quality advertisers share the slots). Purely a function of quality, never of money.
 */
export function rankScored<T extends { id: string; score: number }>(items: T[], nearTieRatio: number, seed: string): T[] {
  const step = Math.log(1 + Math.max(nearTieRatio, 1e-9));
  const band = (s: number) => Math.round(Math.log(Math.max(s, 1e-9)) / step);
  return [...items].sort((a, b) => band(b.score) - band(a.score) || rotationHash(seed, a.id) - rotationHash(seed, b.id) || a.id.localeCompare(b.id));
}

export type PlacementSurface = "search" | "category" | "product_similar" | "home_rail" | "brand_banner";

/**
 * How many sponsored slots a page may carry (design 5.5):
 *  - none below `minOrganicForAds` organic results (cold categories), on unsupported surfaces, or with the kill switch;
 *  - search/category: at most `maxSearchSlots`, 1 per `perOrganicResults` organic results, and never more than
 *    `maxAdShare` of the cards on the page;
 *  - product page rail: at most `maxProductSlots` (no organic minimum: it sits beside the separate organic "similar" rail).
 */
export function slotAllowance(surface: PlacementSurface, organicCount: number, limit: number | undefined, cfg: AdsConfig): number {
  let n: number;
  if (surface === "search" || surface === "category") {
    if (organicCount < cfg.minOrganicForAds) return 0;
    const byRatio = Math.floor(organicCount / cfg.perOrganicResults);
    // ads a, organic n: a <= share * (n + a)  =>  a <= n * share / (1 - share)
    const byShare = Math.floor((organicCount * cfg.maxAdShare) / (1 - cfg.maxAdShare) + 1e-9);
    n = Math.min(cfg.maxSearchSlots, byRatio, byShare);
  } else if (surface === "product_similar") {
    n = cfg.maxProductSlots;
  } else {
    return 0; // home rail / brand banner are Phase 2 / 3
  }
  return Math.max(0, limit === undefined ? n : Math.min(n, limit));
}

export interface PlacedSlot {
  /** 1-based sponsored slot number within the page */
  slot: number;
  /** "top": above the organic results; otherwise inserted after this many organic results */
  after: "top" | number;
}

/** Fixed positions: the first `topCount` slots form the labelled block above organic results; any others follow every 10th result. */
export function placeSlots(count: number, perOrganic: number, topCount = 2): PlacedSlot[] {
  return Array.from({ length: count }, (_, i) => ({ slot: i + 1, after: i < topCount ? ("top" as const) : perOrganic * (i - topCount + 1) }));
}

/**
 * Pure merge for renderers: organic entries keep their exact order and identity; ads are inserted at their fixed
 * positions, never duplicate an organic id, and empty slots simply collapse (organic moves up).
 */
export function mergeSponsored<O extends { id: string }, S extends { id: string; after: "top" | number }>(organic: O[], ads: S[]): { top: S[]; feed: ({ kind: "organic"; item: O } | { kind: "sponsored"; item: S })[] } {
  const organicIds = new Set(organic.map((o) => o.id));
  const usable = ads.filter((a) => !organicIds.has(a.id));
  const top = usable.filter((a) => a.after === "top");
  const inline = usable.filter((a) => a.after !== "top");
  const feed: ({ kind: "organic"; item: O } | { kind: "sponsored"; item: S })[] = [];
  organic.forEach((o, idx) => {
    feed.push({ kind: "organic", item: o });
    for (const a of inline) if (a.after === idx + 1) feed.push({ kind: "sponsored", item: a });
  });
  return { top, feed };
}

/** Pacing (design 5.5): eligible while spend <= dailyBudget * elapsed * multiplier; otherwise participate with a throttled probability. */
export function paceDecision(o: { spentPaise: number; dailyBudgetPaise: number; cpcPaise: number; dayFraction: number; paceMultiplier: number; random: number }): { allowed: boolean; reason?: "budget" | "pacing" } {
  if (o.spentPaise + o.cpcPaise > o.dailyBudgetPaise) return { allowed: false, reason: "budget" };
  // exploration allowance: a campaign that has barely spent can always serve
  if (o.spentPaise <= o.cpcPaise * 3) return { allowed: true };
  const allowedSpend = o.dailyBudgetPaise * Math.max(o.dayFraction, 0.02) * o.paceMultiplier;
  if (o.spentPaise + o.cpcPaise <= allowedSpend) return { allowed: true };
  const p = Math.min(1, Math.max(0.1, allowedSpend / (o.spentPaise + o.cpcPaise)));
  return o.random < p * 0.5 ? { allowed: true } : { allowed: false, reason: "pacing" };
}
