// Ranking-quality metrics for the relevance judgement set (ADR-009). Pure math; the runner lives in eval/run.ts.

/** Graded judgements for one query: item id -> grade (0 = not relevant, 1 = related, 2 = relevant, 3 = ideal). */
export interface Judgement {
  id: string;
  query: string;
  lang: string;
  /** listing "product line" slug -> grade. Missing slugs are grade 0. */
  relevant: Record<string, number>;
}

export interface EvalSummary {
  queries: number;
  ndcg10: number;
  mrr: number;
  /** share of queries with at least one relevant result in the top 10 */
  hitRate10: number;
  /** mean recall@20: share of a query's relevant (grade > 0) items found in the top 20 */
  recall20: number;
}

/** Exponential-gain DCG: (2^grade - 1) / log2(rank + 1), rank starting at 1. */
export function dcgAtK(grades: number[], k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, grades.length); i++) dcg += (2 ** Math.max(0, grades[i]!) - 1) / Math.log2(i + 2);
  return dcg;
}

/**
 * nDCG@k of a ranked list of ids against graded judgements. The ideal ranking is the judgements sorted by grade; ids that
 * appear twice in `ranked` count once (a product line shown twice must not be rewarded twice). 0 when nothing is relevant.
 */
export function ndcgAtK(ranked: string[], relevant: Record<string, number>, k = 10): number {
  const seen = new Set<string>();
  const grades: number[] = [];
  for (const id of ranked) {
    if (seen.has(id)) continue;
    seen.add(id);
    grades.push(relevant[id] ?? 0);
  }
  const ideal = Object.values(relevant).filter((g) => g > 0).sort((a, b) => b - a);
  const idcg = dcgAtK(ideal, k);
  return idcg === 0 ? 0 : dcgAtK(grades, k) / idcg;
}

/** 1 / rank of the first result with grade > 0, or 0. Duplicated ids collapse like in nDCG. */
export function reciprocalRank(ranked: string[], relevant: Record<string, number>): number {
  const seen = new Set<string>();
  let rank = 0;
  for (const id of ranked) {
    if (seen.has(id)) continue;
    seen.add(id);
    rank++;
    if ((relevant[id] ?? 0) > 0) return 1 / rank;
  }
  return 0;
}

/** Share of the relevant (grade > 0) items that appear in the first k distinct results; 0 when nothing is relevant. */
export function recallAtK(ranked: string[], relevant: Record<string, number>, k = 20): number {
  const want = Object.entries(relevant).filter(([, g]) => g > 0).map(([id]) => id);
  if (!want.length) return 0;
  const top = new Set<string>();
  for (const id of ranked) {
    if (top.size >= k) break;
    top.add(id);
  }
  return want.filter((id) => top.has(id)).length / want.length;
}

/** Means over all judged queries. `run` maps a judgement id to the ranked ids returned for its query. */
export function evaluateRun(judgements: Judgement[], run: Record<string, string[]>): EvalSummary & { perQuery: { id: string; ndcg10: number; rr: number; recall20: number }[] } {
  const perQuery = judgements.map((j) => {
    const ranked = run[j.id] ?? [];
    return { id: j.id, ndcg10: ndcgAtK(ranked, j.relevant, 10), rr: reciprocalRank(ranked, j.relevant), recall20: recallAtK(ranked, j.relevant, 20) };
  });
  const n = perQuery.length || 1;
  const mean = (f: (q: (typeof perQuery)[number]) => number) => perQuery.reduce((a, q) => a + f(q), 0) / n;
  return { queries: perQuery.length, ndcg10: mean((q) => q.ndcg10), mrr: mean((q) => q.rr), hitRate10: mean((q) => (q.rr >= 0.1 ? 1 : 0)), recall20: mean((q) => q.recall20), perQuery };
}
