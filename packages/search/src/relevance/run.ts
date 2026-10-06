// Scoring a judgement file against one backend (ADR-009): nDCG@10, MRR, hit-rate@10 and recall@20, overall and per language,
// plus the baseline floor check used by CI. Pure over an injected `rank` function, so it is unit-tested without a database.
import { evaluateRun, type Judgement } from "../eval/metrics";
import type { RelevanceFile } from "./format";

export interface BackendScores {
  queries: number;
  ndcg10: number;
  mrr: number;
  hitRate10: number;
  recall20: number;
  byLang: Record<string, { queries: number; ndcg10: number; mrr: number; recall20: number }>;
}
export type BaselineFile = {
  _doc?: string;
  /** tolerance subtracted from each baseline value to get the CI floor */
  tolerance: number;
  backends: Record<string, Pick<BackendScores, "ndcg10" | "mrr" | "recall20">>;
};

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** `rank` returns the ranked item KEYS (descriptor keys of the file) for a query. */
export async function scoreFile(file: Pick<RelevanceFile, "queries">, rank: (query: string) => Promise<string[]>): Promise<BackendScores & { perQuery: { id: string; ndcg10: number; rr: number; recall20: number; top: string[] }[] }> {
  const run: Record<string, string[]> = {};
  for (const q of file.queries) run[q.id] = await rank(q.query);
  const judgements: Judgement[] = file.queries.map((q) => ({ id: q.id, query: q.query, lang: q.lang, relevant: q.relevant }));
  const e = evaluateRun(judgements, run);
  const lang = new Map(file.queries.map((q) => [q.id, q.lang]));
  const groups = new Map<string, { n: number; ndcg: number; rr: number; rec: number }>();
  for (const p of e.perQuery) {
    const g = groups.get(lang.get(p.id)!) ?? { n: 0, ndcg: 0, rr: 0, rec: 0 };
    g.n++; g.ndcg += p.ndcg10; g.rr += p.rr; g.rec += p.recall20;
    groups.set(lang.get(p.id)!, g);
  }
  return {
    queries: e.queries,
    ndcg10: r3(e.ndcg10),
    mrr: r3(e.mrr),
    hitRate10: r3(e.hitRate10),
    recall20: r3(e.recall20),
    byLang: Object.fromEntries([...groups].sort().map(([l, g]) => [l, { queries: g.n, ndcg10: r3(g.ndcg / g.n), mrr: r3(g.rr / g.n), recall20: r3(g.rec / g.n) }])),
    perQuery: e.perQuery.map((p) => ({ ...p, top: (run[p.id] ?? []).slice(0, 3) })),
  };
}

/** Human-readable regressions of `scores` below `baseline - tolerance` (empty = pass). A missing backend baseline is a failure. */
export function floorViolations(backend: string, scores: Pick<BackendScores, "ndcg10" | "mrr" | "recall20">, baseline: BaselineFile): string[] {
  const b = baseline.backends[backend];
  if (!b) return [`no committed baseline for backend "${backend}"`];
  const out: string[] = [];
  for (const m of ["ndcg10", "mrr", "recall20"] as const) {
    const floor = r3(b[m] - baseline.tolerance);
    if (scores[m] < floor) out.push(`${backend} ${m} ${scores[m]} is below the floor ${floor} (baseline ${b[m]} - ${baseline.tolerance})`);
  }
  return out;
}
