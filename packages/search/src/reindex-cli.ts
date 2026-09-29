// `pnpm --filter @cnote/search reindex` — streams every public listing into a NEW versioned index and swaps the alias.
import { getSearchIndex } from "./index-port";
import { reindexAll } from "./indexer";

const index = getSearchIndex();
if (index.backend === "postgres") {
  console.log("SEARCH_BACKEND=postgres: nothing to index (reads live tables).");
  process.exit(0);
}
const health = await index.health();
if (!health.ok) {
  console.error(`OpenSearch not healthy: ${health.detail}`);
  process.exit(1);
}
const started = Date.now();
const r = await reindexAll(index);
console.log(`reindexed ${r.indexed} listings (${r.failed} failed) into ${r.index} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(r.failed ? 2 : 0);
