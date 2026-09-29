// Pure match-scoring/ranking (ADR-002). Match score = similarity × reliability × geo factor.
// Ranking is relevance × trust — plan/payment never enters (ADR-009).

export interface Candidate {
  sellerBusinessId: string;
  listingId: string;
  similarity: number;
}
export interface SellerSignals {
  trustScore: number; // 0–100
  verificationTier: number; // 0–3
  badgeActive: boolean;
  city: string | null;
  state: string | null;
  pincode: string | null;
}
export interface Geo {
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
}
export interface RankedCandidate extends Candidate {
  matchScore: number;
}

/** 0.5 + 0.5 × trust/100, plus a small bonus for an active badge and for verification tier. Range ≈ 0.5–1.11. */
export function reliabilityFactor(s: Pick<SellerSignals, "trustScore" | "verificationTier" | "badgeActive">): number {
  const trust = Math.min(100, Math.max(0, s.trustScore));
  return 0.5 + (0.5 * trust) / 100 + (s.badgeActive ? 0.05 : 0) + 0.02 * Math.min(3, Math.max(0, s.verificationTier));
}

const norm = (v?: string | null) => (v ?? "").trim().toLowerCase();

/**
 * Simple logistics proxy until real serviceability data exists: same 3-digit pincode prefix
 * (same sorting district) ×1.15, same city ×1.10, same state ×1.05, otherwise ×1.0 (never a penalty:
 * B2B goods ship pan-India).
 */
export function geoFactor(buyer: Geo, seller: Geo): number {
  const bp = norm(buyer.pincode), sp = norm(seller.pincode);
  if (bp.length >= 3 && sp.length >= 3 && bp.slice(0, 3) === sp.slice(0, 3)) return 1.15;
  if (norm(buyer.city) && norm(buyer.city) === norm(seller.city)) return 1.1;
  if (norm(buyer.state) && norm(buyer.state) === norm(seller.state)) return 1.05;
  return 1;
}

export function matchScore(similarity: number, seller: SellerSignals, buyer: Geo): number {
  return Math.max(0, similarity) * reliabilityFactor(seller) * geoFactor(buyer, seller);
}

/**
 * Scores and sorts candidates (desc). Sellers without a profile or in `exclude` are dropped.
 * `preferredSellerId` (enquiry started from that seller's listing) is moved to rank 1 if eligible.
 */
export function rankCandidates(
  candidates: Candidate[],
  profiles: Map<string, SellerSignals>,
  buyer: Geo,
  opts: { exclude?: Iterable<string>; preferredSellerId?: string | null } = {},
): RankedCandidate[] {
  const exclude = new Set(opts.exclude ?? []);
  const seen = new Set<string>();
  const ranked: RankedCandidate[] = [];
  for (const c of candidates) {
    const p = profiles.get(c.sellerBusinessId);
    if (!p || exclude.has(c.sellerBusinessId) || seen.has(c.sellerBusinessId)) continue;
    seen.add(c.sellerBusinessId);
    ranked.push({ ...c, matchScore: matchScore(c.similarity, p, buyer) });
  }
  ranked.sort((a, b) => b.matchScore - a.matchScore);
  const pref = opts.preferredSellerId ? ranked.findIndex((r) => r.sellerBusinessId === opts.preferredSellerId) : -1;
  if (pref > 0) ranked.unshift(...ranked.splice(pref, 1));
  return ranked;
}

/**
 * Cascade slot assignment: the vacated rank slots (1..cap not held by an active match) are refilled,
 * best candidate first, lowest rank first. Keeps at most `cap` active matches.
 */
export function assignSlots(ranked: RankedCandidate[], activeRanks: number[], cap: number): { rank: number; candidate: RankedCandidate }[] {
  const used = new Set(activeRanks);
  const free: number[] = [];
  for (let r = 1; r <= cap; r++) if (!used.has(r)) free.push(r);
  return free.slice(0, ranked.length).map((rank, i) => ({ rank, candidate: ranked[i]! }));
}
