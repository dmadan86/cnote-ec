// Relevance evaluation against the seeded database (ADR-009): nDCG@10 and MRR over eval/judgements.json.
//
//   pnpm --filter @cnote/search eval                  # with cross-script variants, plus a SEARCH_TRANSLIT=off baseline
//   pnpm --filter @cnote/search eval -- --verbose     # per-query lines
//   pnpm --filter @cnote/search eval -- --json        # machine-readable summary only
//
// Needs Postgres + Redis and `pnpm db:seed`. The judgements reference PRODUCT-LINE slugs of the DUMMY seed data; real
// catalogue data will replace it (see the `_doc` field). Not part of CI; the metric math is unit-tested (test/eval-metrics.test.ts).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluateRun, type Judgement } from "../src/eval/metrics";
import { searchListings } from "../src/search";

interface JudgementFile {
  catalogue: Record<string, { category: string; titles: string[] }>;
  queries: Judgement[];
}

const file = JSON.parse(readFileSync(fileURLToPath(new URL("./judgements.json", import.meta.url)), "utf8")) as JudgementFile;
const titleToSlug = new Map<string, string>();
for (const [slug, v] of Object.entries(file.catalogue)) for (const t of v.titles) titleToSlug.set(t.toLowerCase(), slug);
const slugOf = (title: string) => titleToSlug.get(title.toLowerCase()) ?? `unknown:${title}`;

async function runAll(): Promise<Record<string, string[]>> {
  const run: Record<string, string[]> = {};
  for (const j of file.queries) {
    const res = await searchListings({ q: j.query, limit: 10 });
    run[j.id] = res.hits.map((h) => slugOf(h.listing.title));
  }
  return run;
}

const byLang = (rows: { id: string; ndcg10: number; rr: number }[]) => {
  const langOf = new Map(file.queries.map((q) => [q.id, q.lang]));
  const groups = new Map<string, { n: number; ndcg: number; rr: number }>();
  for (const r of rows) {
    const g = groups.get(langOf.get(r.id)!) ?? { n: 0, ndcg: 0, rr: 0 };
    g.n++; g.ndcg += r.ndcg10; g.rr += r.rr;
    groups.set(langOf.get(r.id)!, g);
  }
  return Object.fromEntries([...groups].map(([l, g]) => [l, { queries: g.n, ndcg10: +(g.ndcg / g.n).toFixed(3), mrr: +(g.rr / g.n).toFixed(3) }]));
};

const args = new Set(process.argv.slice(2));
process.env.SEARCH_TRANSLIT = "on";
const withRun = await runAll();
process.env.SEARCH_TRANSLIT = "off";
const baseRun = await runAll();
process.env.SEARCH_TRANSLIT = "on";

const a = evaluateRun(file.queries, withRun);
const b = evaluateRun(file.queries, baseRun);
const round = (n: number) => +n.toFixed(3);
const summary = {
  queries: a.queries,
  withVariants: { ndcg10: round(a.ndcg10), mrr: round(a.mrr), hitRate10: round(a.hitRate10), byLang: byLang(a.perQuery) },
  baseline: { ndcg10: round(b.ndcg10), mrr: round(b.mrr), hitRate10: round(b.hitRate10), byLang: byLang(b.perQuery) },
};
if (args.has("--verbose")) {
  for (const j of file.queries) {
    const pa = a.perQuery.find((p) => p.id === j.id)!;
    const pb = b.perQuery.find((p) => p.id === j.id)!;
    console.log(`${j.id} [${j.lang}] ${j.query}  ndcg ${pb.ndcg10.toFixed(2)} -> ${pa.ndcg10.toFixed(2)}  top: ${(withRun[j.id] ?? []).slice(0, 3).join(", ")}`);
  }
}
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
