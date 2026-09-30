// Query-side semantic text for non-Latin and mixed-script queries (search-v2 limitation 3).
// The hashing embedder only "knows" Latin tokens (listings are embedded from English/Latin text), so an Indic query
// embeds to noise. We embed the best Latin variant produced by transliteration + lexicon instead, optionally blended
// with the original. Pure and deterministic; listing embeddings are untouched (no re-index needed).
import { hasIndic } from "./translit/indic";

const INDIC_RE = /[\u0900-\u0DFF]/u;

/** Fraction of the original query embedding kept when blending with the Latin variant (0 = variant only). */
export const ORIGINAL_BLEND = 0;

export interface SemanticPlan {
  /** texts to embed, first = primary (Latin variant), optional second = original for blending */
  texts: string[];
  /** blend weights, same length as texts, sum to 1 */
  weights: number[];
}

/** The first variant with no Indic characters (expandQuery orders the English rewrite first), or null. */
export function bestLatinVariant(text: string, variants: string[]): string | null {
  if (!hasIndic(text)) return null;
  return variants.find((v) => v.trim() && !INDIC_RE.test(v)) ?? null;
}

/**
 * Plan what to embed. Latin/English/Hinglish queries are untouched (single original text). Indic or mixed-script queries
 * with a fully-Latin variant embed [variant, original] blended (variant dominant).
 */
export function planSemantic(text: string, variants: string[], blend = ORIGINAL_BLEND, latinBlend = 0): SemanticPlan {
  const v = bestLatinVariant(text, variants);
  if (!v) {
    // Latin query (English/Hinglish): a lexicon-canonicalised variant (kursi -> chair) is blended in at LATIN_BLEND.
    const lat = latinBlend > 0 && !hasIndic(text) ? variants.find((x) => x.trim() && !INDIC_RE.test(x)) : undefined;
    return lat ? { texts: [text, lat], weights: [1 - latinBlend, latinBlend] } : { texts: [text], weights: [1] };
  }
  if (blend <= 0) return { texts: [v], weights: [1] };
  return { texts: [v, text], weights: [1 - blend, blend] };
}

/** Weighted mean of unit vectors, re-normalised (cosine search expects unit length). */
export function blendVectors(vectors: number[][], weights: number[]): number[] {
  const first = vectors[0];
  if (!first) return [];
  const out = new Array<number>(first.length).fill(0);
  vectors.forEach((vec, k) => {
    const w = weights[k] ?? 0;
    for (let i = 0; i < out.length; i++) out[i]! += w * (vec[i] ?? 0);
  });
  const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0)) || 1;
  return out.map((x) => x / norm);
}
