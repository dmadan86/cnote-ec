// Ranking as pure functions (ADR-009): relevance fusion × trust. Payment/plan never enters.
export const RRF_K = 60;
/** Cosine similarity below this is noise for the hashing embedder; the vector list ignores such hits. */
export const MIN_SIMILARITY = 0.12;
export const LOCATION_BOOST = 1.1;

export interface Candidate {
  listingId: string;
  sellerBusinessId: string;
  lexicalRank: number; // ts_rank_cd score, 0 = no lexical match
  similarity: number; // 1 - cosine distance, 0 = absent
}

/**
 * Reciprocal Rank Fusion: score = Σ 1/(k + rank_i) over the lexical and vector lists.
 * Chosen over a weighted sum because ts_rank_cd and cosine similarity live on unrelated scales, and RRF needs no
 * per-query calibration. Output is normalised to 0..1 (max = present at rank 1 in both lists).
 */
export function rrfFuse(cands: Candidate[], k = RRF_K): Map<string, number> {
  const out = new Map<string, number>();
  const add = (list: Candidate[]) => list.forEach((c, i) => out.set(c.listingId, (out.get(c.listingId) ?? 0) + 1 / (k + i + 1)));
  add(cands.filter((c) => c.lexicalRank > 0).sort((a, b) => b.lexicalRank - a.lexicalRank));
  add(cands.filter((c) => c.similarity >= MIN_SIMILARITY).sort((a, b) => b.similarity - a.similarity));
  const max = 2 / (k + 1);
  for (const [id, v] of out) out.set(id, v / max);
  return out;
}

/** 0.6..1.0 from trustScore (0-100), plus a small verified-badge bonus. Never plan/payment (ADR-009). */
export function trustFactor(p: { trustScore: number; badgeActive: boolean }): number {
  const t = Math.min(100, Math.max(0, p.trustScore));
  return 0.6 + 0.4 * (t / 100) + (p.badgeActive ? 0.03 : 0);
}

export function locationBoost(sellerCity: string | null, hint: string | null): number {
  if (!hint || !sellerCity) return 1;
  return sellerCity.trim().toLowerCase() === hint ? LOCATION_BOOST : 1;
}

/** Port hits → fusion candidates. Shared by every backend so ranking is identical (RRF parity). */
export function toCandidates(hits: { listingId: string; sellerBusinessId: string; lexicalScore: number; vectorScore: number }[]): Candidate[] {
  return hits.map((h) => ({ listingId: h.listingId, sellerBusinessId: h.sellerBusinessId, lexicalRank: h.lexicalScore, similarity: h.vectorScore }));
}
