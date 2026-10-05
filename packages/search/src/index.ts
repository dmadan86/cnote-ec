// @cnote/search — hybrid lexical + semantic search, trust-weighted ranking (ADR-009).
// Rank = relevance × trust; never by paid tier. Sponsored slots (none in Phase 1) must be labelled.
// PUBLIC CONTRACT. Extend, don't break.
import type { ListingView } from "@cnote/catalogue";
import type { TrustProfile } from "@cnote/identity";

export interface SearchHit {
  listing: ListingView;
  seller: TrustProfile;
  score: number;
  sponsored: false;
}

export { searchListings } from "./search";
export {
  SORTS, MAX_TIER, PRICE_RANGES, filtersSchema, normaliseFilters, matchesFilters, computeFacets, priceBucketKey, sortOrganic, isSearchSort, hasActiveFilters,
  type SearchSort, type SearchFilters, type IndexFilters, type OrganicItem, type FilterRow, type FacetCounts,
} from "./filters";
export { suggest, EXAMPLE_QUERIES } from "./suggest";
export { normaliseQuery, type NormalisedQuery } from "./normalise";
export { expandQuery, romanVariants, toRoman, fromRoman, colloquial, detectScript, hasIndic, type IndicScript } from "./translit";
export { ndcgAtK, reciprocalRank, evaluateRun, type Judgement, type EvalSummary } from "./eval/metrics";

export { cacheWorker, cacheHandlers } from "./cache-worker";

// Swappable index backend (postgres | opensearch by SEARCH_BACKEND) and its indexer worker.
export { getSearchIndex, searchBackendName, OpenSearchIndex, postgresIndex } from "./index-port";
export type { SearchIndex, SearchIndexQuery, SearchIndexResult, IndexDoc, RawHit, SearchFacets, FacetBucket, PriceBucket, IndexHealth, ReindexResult, SearchBackendName } from "./index-port";
export { searchIndexer, indexerHandlers, syncListings, reindexAll } from "./indexer";

// Staff-curated synonym dictionary: versioned data, edited in the admin console (ADR-004, ADR-009).
export {
  checkGroups, parseGroupsText, formatGroupsText, parseSolr, toSolrLines, synonymVariants, normaliseTerm, MAX_GROUPS, MAX_TERMS_PER_GROUP, MAX_TERM_LENGTH,
  type SynonymGroup, type GroupsCheck,
} from "./synonyms/groups";
export {
  getActiveSynonyms, listSynonymVersions, getSynonymVersion, publishSynonyms, rollbackSynonyms, importBuiltInSynonyms, activeSynonymLines, invalidateSynonymCache,
  type SynonymSet, type SynonymVersionSummary,
} from "./synonyms/store";

// Relevance judgements: file format, staff-recorded grades, scoring (ADR-009). `eval:relevance` is the CLI.
export { parseRelevanceFile, productKeyOf, queryKeyOf, type RelevanceFile, type CorpusItem, type RelevanceQuery } from "./relevance/format";
export { recordJudgement, listJudgements, judgedQueries, deleteJudgement, exportJudgements, type JudgementView, type RecordJudgementInput } from "./relevance/judgements";
export { rankIds, type RankOptions } from "./relevance/rank";
export { scoreFile, floorViolations, type BackendScores, type BaselineFile } from "./relevance/run";
export { recallAtK } from "./eval/metrics";
