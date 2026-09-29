# Search index: Postgres <-> OpenSearch

Status: implemented in `packages/search` (ports and adapters, like the queue factory). Related: ADR-009, `performance-and-seo.md`.

## Design

`searchListings()` (public signature unchanged) calls `getSearchIndex().search()`. The `SearchIndex` port
(`src/index-port/types.ts`) has `search`, `upsert`, `remove`, `health`, `reindexAll`. Backend is chosen by `SEARCH_BACKEND=postgres|opensearch` (default `postgres`).

- Adapters return raw per-list scores (`lexicalScore`, `vectorScore`). Fusion (RRF k=60), trust factor and location boost live in `searchListings` and run identically on both backends, so ranking never depends on the engine. Only the order of each list matters to RRF, so BM25 vs `ts_rank_cd` scale differences are irrelevant (unit-tested).
- Postgres adapter wraps `catalogue.retrieveListings` (FTS + pgvector on live tables). `upsert`/`remove` are no-ops.
- OpenSearch adapter runs a BM25 request and a kNN request in parallel and merges by listing id.
- The Redis tagged cache in front of `searchListings` is unchanged (key includes the backend).
- Additive result fields: `nextCursor` and `facets` (category, city, verification tier, price ranges). Postgres returns neither. Cursor is an opaque offset; each page is fused independently, so deep paging is approximate.

## When to switch

Switch to OpenSearch when any of these hold:
- more than 1-2M live listings (Postgres FTS + HNSW stay fine below this),
- search p95 above 150 ms at target load after tuning,
- product needs facets/aggregations or typo tolerance (`fuzziness: AUTO`) or typeahead over title n-grams.

Below that, stay on Postgres: no extra infrastructure, and reads are always consistent with the catalogue.

## Mapping (`src/index-port/mapping.ts`)

Concrete indices `listings_v<N>`, alias `listings`. `dynamic: strict`.

| Field | Type |
|---|---|
| title | text, `indic` analyzer, search analyzer `indic_search` (with synonyms); subfields `title.shingles` (2-3 word shingles), `title.edge` (edge n-gram 2-15, typeahead) |
| description, categoryName | text, same analyzers |
| categoryId, categorySlug, sellerBusinessId, listingId | keyword |
| city, state | keyword, lowercase normalizer |
| verificationTier | keyword |
| trustScore | float; pricePaise, moq: long; badgeActive: boolean; updatedAt: date |
| embedding | `knn_vector`, dim 256, HNSW, cosinesimil, Lucene engine (no native lib dependency; score `(1+cos)/2` converted back to cosine) |

`indic` uses `icu_tokenizer` + `icu_folding` when the `analysis-icu` plugin is present (detected via `_cat/plugins`), otherwise `standard` + `lowercase` + `asciifolding`. AWS OpenSearch Service ships analysis-icu.

Synonyms: `packages/search/synonyms/hinglish-b2b.txt` (dabba => box, gatta => carton, ...). Mirrors the map in `@cnote/ai` (which does not export it; keep in step). Applied at search time only, so changing them never requires reindexing. By default the file is inlined at index creation. On AWS, upload it as a TXT-DICTIONARY package, associate it with the domain and set `OPENSEARCH_SYNONYMS_PACKAGE_PATH=analyzers/<package-id>` (then use the `_plugins/_refresh_search_analyzers/listings` API after edits).

## Indexing

`searchIndexer` (a `ModuleWorker`, name `search-indexer`) observes ListingVersionPublished, ListingUnpublished, ListingArchived, ListingModerated, ListingImageModerated, TrustScoreChanged, BusinessVerified.
- It re-reads the current public projection (`getPublicListingsByIds`, `getTrustProfiles`, `listPublicSellerListings`) and upserts live listings / removes the rest. Takedown events (unpublished, archived, rejected) remove directly without a cached read.
- Idempotent and order-insensitive: writes use external versioning (`external_gte`, version = ms timestamp of the read). Replays rewrite the same doc; an older concurrent write gets a 409, treated as success.
- Embeddings are computed with `ai.embed` at index time; on embedder failure the doc is indexed without a vector and healed by the next event or reindex.
- No-op when `SEARCH_BACKEND=postgres`.

## Reindex runbook (zero downtime)

```
SEARCH_BACKEND=opensearch OPENSEARCH_URL=... pnpm --filter @cnote/search reindex
```
1. Creates `listings_v<N+1>` (0 replicas), bulk-loads every public listing in batches of 200, refreshes.
2. Swaps alias `listings` atomically (remove old + add new in one `_aliases` call).
3. Keeps the previous index for rollback, deletes older ones. On failure the half-built index is dropped and the alias is untouched.
4. Set replicas on the new index afterwards if you use more than 0 (`PUT listings_v<N+1>/_settings {"index":{"number_of_replicas":1}}`).
5. Events processed during the load went to the old index; run the reindex once more (cheap, idempotent) or let subsequent events converge. Rollback: point the alias back at the previous index.

Use it on first switch-over, after any mapping/analyzer change, and after changing the embedding model (`EMBEDDER_VERSION`).

## Switching backends

1. Provision OpenSearch, set `OPENSEARCH_URL` (+ `OPENSEARCH_USERNAME`/`OPENSEARCH_PASSWORD`).
2. Set `SEARCH_BACKEND=opensearch` on the worker only, run the reindex, let the indexer run (dual-run: web still on Postgres).
3. Verify `health()` and compare a sample of queries; then set `SEARCH_BACKEND=opensearch` on web. Rollback = set it back to `postgres` (the live tables never stopped being authoritative).

Env: `SEARCH_BACKEND`, `OPENSEARCH_URL`, `OPENSEARCH_USERNAME`, `OPENSEARCH_PASSWORD`, `OPENSEARCH_INSECURE_TLS` (dev only), `OPENSEARCH_SYNONYMS_PACKAGE_PATH`.

## AWS OpenSearch Service (ap-south-1 Mumbai / ap-south-2 Hyderabad)

- Engine OpenSearch 2.x (k-NN with Lucene engine is built in), 3 dedicated master nodes for production, 2-3 data nodes across 2-3 AZs, 1 replica.
- Start small: 2 x `r6g.large.search` (or `m6g.large`) with gp3 100 GB is plenty for 1-2M listings (about 1 KB text + 1 KB vector each, so a few GB). Use UltraWarm only for logs, not here.
- Put it in a VPC (private subnets), enable encryption at rest / node-to-node, fine-grained access control. This client uses basic auth (master or a scoped internal user). SigV4/IAM signing needs `@opensearch-project/opensearch/aws` plus an AWS credentials package; not added yet (see gaps).
- Cost note: two `r6g.large` data nodes + three `m6g.large` masters is roughly USD 500-700/month in ap-south-1 plus storage; OpenSearch Serverless has a 2-OCU/4-OCU floor (about USD 350-700/month) and is not cheaper at this scale. Do not move before the thresholds above justify it.
- Portability: the adapter uses only the standard REST API, so self-hosted OpenSearch or Aiven (Azure/GCP) work by changing `OPENSEARCH_URL`. Avoid AWS-only features.

## Local development

```
docker run -d --name os -p 9200:9200 -e discovery.type=single-node \
  -e OPENSEARCH_INITIAL_ADMIN_PASSWORD='Str0ng!Passw0rd' opensearchproject/opensearch:2
# ICU plugin (optional; falls back automatically):
docker exec os bin/opensearch-plugin install analysis-icu && docker restart os
export SEARCH_BACKEND=opensearch OPENSEARCH_URL=https://localhost:9200 \
  OPENSEARCH_USERNAME=admin OPENSEARCH_PASSWORD='Str0ng!Passw0rd' OPENSEARCH_INSECURE_TLS=true
pnpm --filter @cnote/search reindex
```
Run the live contract tests with `OPENSEARCH_URL` set (they are skipped otherwise): `pnpm --filter @cnote/search test`.

## Known gaps

- No SigV4 auth; cursor paging is per-page fusion; facets are computed over the lexical match set only; the synonym file is a copy of the `@cnote/ai` map; typeahead (`OpenSearchIndex.suggest`) exists but `suggest()` still uses catalogue titles; no auto-detection of an embedding model change (reindex manually).
