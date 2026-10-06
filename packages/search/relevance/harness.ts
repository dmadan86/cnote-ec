// Shared by the CLI (run.ts) and the CI test (test/relevance.db.test.ts): evaluate the committed fixture on one backend.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRelevanceFile, type RelevanceFile } from "../src/relevance/format";
import { rankIds, type RankOptions } from "../src/relevance/rank";
import { scoreFile, type BaselineFile } from "../src/relevance/run";
import { loadOpenSearchCorpus, loadPostgresCorpus, type LoadedCorpus } from "./corpus";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export const loadFixtureFile = (): RelevanceFile => parseRelevanceFile(JSON.parse(readFileSync(here("./fixtures.json"), "utf8")));
export const loadBaselineFile = (): BaselineFile => JSON.parse(readFileSync(here("./baseline.json"), "utf8")) as BaselineFile;
export const baselinePath = () => here("./baseline.json");

export type BackendName = "postgres" | "opensearch";

/** Loads the fixture corpus into `backend`, scores every query, and always cleans up. */
export async function evaluateFixture(file: RelevanceFile, backend: BackendName, rank: RankOptions = {}) {
  if (!file.corpus) throw new Error("the fixture file has no corpus");
  const loaded: LoadedCorpus = await (backend === "opensearch" ? loadOpenSearchCorpus(file.corpus) : loadPostgresCorpus(file.corpus));
  try {
    return await scoreFile(file, async (q) => (await rankIds(loaded.index, q, { ...rank, filters: loaded.filters })).flatMap((id) => (loaded.keyOf.has(id) ? [loaded.keyOf.get(id)!] : [])));
  } finally {
    await loaded.cleanup();
  }
}
