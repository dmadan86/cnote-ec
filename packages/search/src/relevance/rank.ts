// Query -> ranked listing ids over ANY SearchIndex, for relevance evaluation. This is `searchListingsLocal`'s retrieval and
// fusion path (normalise, curated + built-in variants, planSemantic embedding, index.search, rrfFuse with the same
// weights) WITHOUT the trust factor, listing hydration and cache: a fixture corpus has no seller trust profiles, and
// trust is orthogonal to text relevance (ADR-009: relevance x trust). Keep the two in step; test/relevance-parity.test.ts
// holds search.ts and this function to the same ordering.
import * as ai from "@cnote/ai";
import type { IndexFilters } from "../filters";
import { fusionWeights, rrfFuse, toCandidates } from "../fusion";
import type { SearchIndex } from "../index-port";
import { normaliseQuery } from "../normalise";
import { blendVectors, planSemantic } from "../semantic";
import { MAX_SYNONYM_VARIANTS, mergeVariants, synonymVariants, type SynonymGroup } from "../synonyms/groups";
import { expandQuery, MAX_VARIANTS } from "../translit/variants";

export interface RankOptions {
  /** curated dictionary groups (default none) */
  synonyms?: SynonymGroup[];
  /** cross-script variants (default on, like production) */
  translit?: boolean;
  semanticBlend?: number;
  latinBlend?: number;
  indicLexicalWeight?: number;
  /** how many ids to return (default 20, the recall@20 horizon) */
  limit?: number;
  /** candidate pool requested from the index (default 60) */
  pool?: number;
  /** scope to a fixture corpus (category ids), so unrelated listings in the same database cannot compete */
  filters?: IndexFilters;
}

export async function rankIds(index: SearchIndex, rawQuery: string, o: RankOptions = {}): Promise<string[]> {
  const nq = normaliseQuery(rawQuery);
  const text = nq.text;
  if (!text) return [];
  const translit = o.translit ?? true;
  const variants = mergeVariants(synonymVariants(text, o.synonyms ?? []), translit ? expandQuery(text) : [], MAX_VARIANTS + MAX_SYNONYM_VARIANTS);
  let embedding: number[] | undefined;
  try {
    const plan = planSemantic(text, variants, o.semanticBlend ?? 0, o.latinBlend ?? 0);
    const { vectors } = await ai.embed(plan.texts);
    embedding = plan.texts.length === 1 ? vectors[0] : blendVectors(vectors, plan.weights);
  } catch {
    embedding = undefined;
  }
  const res = await index.search({ text, location: nq.location, embedding, limit: o.pool ?? 60, ...(o.filters ? { filters: o.filters } : {}), ...(variants.length ? { variants } : {}) });
  const cands = toCandidates(res.hits);
  const fused = rrfFuse(cands, undefined, ...fusionWeights(text, translit, o.indicLexicalWeight));
  return [...fused.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, o.limit ?? 20)
    .map(([id]) => id);
}
