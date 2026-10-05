import { activeSynonymLines } from "../synonyms/store";
import { OpenSearchIndex, createOpenSearchClient, type OsClient } from "./opensearch";
import { postgresIndex } from "./postgres";
import type { SearchBackendName, SearchIndex } from "./types";

export function searchBackendName(env: NodeJS.ProcessEnv = process.env): SearchBackendName {
  const v = (env.SEARCH_BACKEND ?? "postgres").toLowerCase();
  if (v !== "postgres" && v !== "opensearch") throw new Error(`Unknown SEARCH_BACKEND "${v}" (postgres | opensearch)`);
  return v;
}

let cached: { name: SearchBackendName; index: SearchIndex } | undefined;
let override: SearchIndex | undefined;

/** Process-wide index selected by SEARCH_BACKEND (default postgres), like the queue factory. */
export function getSearchIndex(): SearchIndex {
  if (override) return override;
  const name = searchBackendName();
  if (cached?.name === name) return cached.index;
  const index =
    name === "opensearch"
      ? new OpenSearchIndex(createOpenSearchClient() as unknown as OsClient, { synonymsPackagePath: process.env.OPENSEARCH_SYNONYMS_PACKAGE_PATH, extraSynonyms: activeSynonymLines })
      : postgresIndex;
  cached = { name, index };
  return index;
}

/** Tests only. */
export function setSearchIndexForTests(index: SearchIndex | undefined) {
  override = index;
  cached = undefined;
}
