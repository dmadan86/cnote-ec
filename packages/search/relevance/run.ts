// Relevance evaluation (ADR-009): nDCG@10, MRR, hit-rate@10 and recall@20 per backend.
//
//   pnpm --filter @cnote/search eval:relevance                       # committed fixture on Postgres (+ OpenSearch when OPENSEARCH_URL is set)
//   pnpm --filter @cnote/search eval:relevance -- --backends postgres,opensearch --verbose
//   pnpm --filter @cnote/search eval:relevance -- --write-baseline   # after an INTENDED ranking change: rewrites relevance/baseline.json
//   pnpm --filter @cnote/search eval:relevance -- --judgements staff-export.json   # staff judgements from the admin console, scored on the LIVE index
//
// Fixture mode builds its corpus inside the run (no seed data needed) and exits 1 when a metric falls below the committed
// baseline minus its tolerance, exactly like the CI test. `--judgements` mode scores the running catalogue with
// `searchListings` (the full pipeline, SEARCH_BACKEND decides the backend) and maps hits to the file's descriptor keys by title.
import { readFileSync, writeFileSync } from "node:fs";
import { parseRelevanceFile, productKeyOf } from "../src/relevance/format";
import { floorViolations, scoreFile, type BaselineFile } from "../src/relevance/run";
import { searchListings } from "../src/search";
import { baselinePath, evaluateFixture, loadBaselineFile, loadFixtureFile, type BackendName } from "./harness";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);

async function liveMode(path: string) {
  const file = parseRelevanceFile(JSON.parse(readFileSync(path, "utf8")));
  const scores = await scoreFile(file, async (q) => (await searchListings({ q, limit: 20 })).hits.map((h) => productKeyOf(h.listing.title)));
  console.log(JSON.stringify({ mode: "live", backend: process.env.SEARCH_BACKEND ?? "postgres", ...scores, perQuery: undefined }, null, 2));
  if (flag("verbose")) for (const p of scores.perQuery) console.log(`${p.id} ndcg ${p.ndcg10.toFixed(2)} rr ${p.rr.toFixed(2)} top: ${p.top.join(", ")}`);
}

async function fixtureMode() {
  const file = loadFixtureFile();
  const wanted = (opt("backends") ?? (process.env.OPENSEARCH_URL ? "postgres,opensearch" : "postgres")).split(",") as BackendName[];
  const results: Record<string, Awaited<ReturnType<typeof evaluateFixture>>> = {};
  for (const b of wanted) results[b] = await evaluateFixture(file, b);

  if (flag("write-baseline")) {
    const prev = (() => {
      try {
        return loadBaselineFile();
      } catch {
        return null;
      }
    })();
    const next: BaselineFile = {
      _doc: "Committed floor for the relevance fixture (ADR-009). CI fails when a metric drops below value - tolerance. Rewrite only for an intended ranking change: pnpm --filter @cnote/search eval:relevance -- --write-baseline",
      tolerance: prev?.tolerance ?? 0.02,
      backends: { ...(prev?.backends ?? {}), ...Object.fromEntries(Object.entries(results).map(([b, r]) => [b, { ndcg10: r.ndcg10, mrr: r.mrr, recall20: r.recall20 }])) },
    };
    writeFileSync(baselinePath(), `${JSON.stringify(next, null, 2)}\n`);
    console.log(`baseline written: ${baselinePath()}`);
  }

  const baseline = loadBaselineFile();
  let failed = false;
  for (const [b, r] of Object.entries(results)) {
    console.log(JSON.stringify({ backend: b, queries: r.queries, ndcg10: r.ndcg10, mrr: r.mrr, hitRate10: r.hitRate10, recall20: r.recall20, byLang: r.byLang }, null, 2));
    if (flag("verbose")) for (const p of r.perQuery) console.log(`  ${p.id} ndcg ${p.ndcg10.toFixed(2)} rr ${p.rr.toFixed(2)} top: ${p.top.join(", ")}`);
    const bad = floorViolations(b, r, baseline);
    if (bad.length) {
      failed = true;
      for (const m of bad) console.error(`FAIL ${m}`);
    }
  }
  if (!failed) console.log("relevance floor: OK");
  process.exitCode = failed ? 1 : 0;
}

const live = opt("judgements");
await (live ? liveMode(live) : fixtureMode());
process.exit(process.exitCode ?? 0);
