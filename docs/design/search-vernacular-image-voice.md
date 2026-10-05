# Search: curated vernacular synonyms, relevance judgements, image and voice search

Closes the remaining ADR-009 gaps on top of `search-v2.md` (cross-script transliteration, voice and photo routes already shipped there).
Governed by ADR-004 (Bharat-native: vernacular, mixed script), ADR-008 (AI through `@cnote/ai`), ADR-009 (Postgres FTS + pgvector,
OpenSearch adapter at ranking parity) and ADR-010 (voice and photos are personal data).

## What already existed (not rebuilt)

Transliteration for Devanagari (hi, mr), Bengali, Gujarati, Tamil, Telugu and Kannada (`translit/indic.ts`, ISO-15919-style table,
virama, matras, nukta, anusvara/chandrabindu), a 215-row code lexicon, `expandQuery` variants, the semantic plan for Indic queries,
`/api/search/voice` and `/api/search/image` with `SearchTools`, and a seed-bound 80-query judgement set (`eval/judgements.json`).

## 1. Curated synonym dictionary (data, versioned, staff-editable)

- **Data**: `search_synonym_versions` (`packages/db/prisma/schema/search.prisma`, owned by `@cnote/search`). Immutable snapshots; the
  active dictionary is the highest `version`. Publishing appends N+1, rollback appends a COPY of an old snapshot (history is never
  rewritten). `groups` = `[{ terms: string[], note? }]`; every term in a group is interchangeable, in any script.
- **Code**: `src/synonyms/groups.ts` (pure: validation, editor text format, Solr lines, `synonymVariants`) and `store.ts` (DB, 30 s
  in-process cache, local invalidation on publish, lost-update guard `editedFrom`, race retry on the unique version).
- **Query path**: `searchListings` merges `synonymVariants(text, groups)` AHEAD of the built-in `expandQuery` variants (staff-judged beats
  heuristic) into the same `variants` channel. That one list is (a) OR-ed into Postgres FTS (`retrieveListings`), (b) OR-ed as
  down-weighted `multi_match` clauses on OpenSearch (`buildLexicalRequest`) and (c) the source of the Latin text that `planSemantic`
  embeds for vector search. Because both backends receive identical variants, ranking parity is by construction; the existing index-port
  and parity tests stay green and `test/synonyms-search.test.ts` adds the synonym cases. The dictionary version is part of the search
  cache key (the key prefix stays `search:q:v6`), so a publish changes every affected key at once.
- **OpenSearch index side**: `OpenSearchIndex` takes `extraSynonyms` (wired to the active dictionary in `getSearchIndex`) and adds the lines
  next to the shipped `synonyms/hinglish-b2b.txt` whenever an index is built; a failing provider is ignored. Query-side expansion is what
  takes effect immediately; index analyzers pick the dictionary up at the next reindex (or via the managed synonym package).
- **Kill switch**: `SEARCH_SYNONYMS=off` ignores the dictionary (`SEARCH_TRANSLIT=off` still governs the built-in lexicon).
- **Admin** (`/search/synonyms`, privileges `search.read` / `search.manage`, role ops_moderator + super_admin): text editor (one group per
  line, `kapda, कपड़ा, cloth, fabric   # note`), "Try a query" panel showing the dictionary and built-in variants side by side, version
  history with rollback, one-click import of the shipped starter file. Every mutation goes through `audited()`
  (`search.synonyms.publish|rollback|import`).
- **Transliteration fix**: a word-final anusvara in Tamil/Telugu/Kannada is now spelled with `m` first (`బియ్యం` -> `biyyam`), `n` second.
  `test/translit-words.test.ts` pins ~45 real trade words across all six scripts (typed spellings, strict ISO form for key cases).

## 2. Relevance judgements, nDCG and the CI floor

- **Format** (`src/relevance/format.ts`): `{ version, corpus?, products?, queries: [{ id, query, lang, relevant: { <descriptor key>: 0..3 } }] }`.
  Items are identified by the slug of their title (a seed-independent descriptor), never a database id.
- **Fixture** (`packages/search/relevance/fixtures.json`): 36 products in 8 categories and 60 queries (en 14, hinglish 13, hi 11, mr/gu/kn/ta/te/bn 3
  each, mixed 4). The corpus is written INSIDE the run to the live read DB under fresh random category ids (retrieval is scoped to them)
  and removed afterwards, so nothing depends on seed rows. Grades were assigned from the products' meaning, not tuned to the ranker.
- **Metrics**: nDCG@10, MRR, hit-rate@10 and recall@20, overall and per language (`src/relevance/run.ts`, `eval/metrics.ts`).
- **CLI**: `pnpm --filter @cnote/search eval:relevance` (Postgres; plus OpenSearch when `OPENSEARCH_URL` is set, on a private
  `relevance_<id>` alias that is deleted afterwards). `-- --verbose`, `-- --write-baseline` (intended ranking changes only),
  `-- --judgements staff-export.json` (scores the LIVE catalogue through `searchListings`, mapping hits to the file's keys by title).
- **Baseline**: `relevance/baseline.json` (postgres: nDCG@10 0.94, MRR 0.983, recall@20 0.867) with tolerance 0.02. `test/relevance.db.test.ts` fails
  below baseline minus tolerance and below absolute sanity floors, and proves a curated group lifts a query ("kapda" also means garments).
  An `opensearch` baseline is added the first time the script runs against a cluster (CI has none), until then that backend is not floored.
- **Admin** (`/search/judgements`): run a buyer query, grade each live result 0-3 (stored per (query, product key), re-judging overwrites,
  audited), see recorded grades, delete, and export the JSON file (audited). Honest limits: 60 queries is a smoke floor, not a statistical
  guarantee; hinglish single-word queries ("kursi", "bijli ka taar") are the known weak spot the fixture exposes.
- `src/relevance/rank.ts` mirrors `searchListings`' retrieval and fusion minus trust and hydration; `test/synonyms-search.test.ts` holds
  the two to the same ordering.

## 3. Image search (existing pipeline, gaps closed)

Pipeline unchanged and reviewed: route handler (rate limit, Turnstile, `validateImage`, 5 MB cap, in-memory re-encode dropping EXIF/GPS),
`deriveImageSearch` (reuses the `extractListingFromImages` prompt, so the eval manifest, golden set and AiDecision audit already apply;
no system prompt text changed, so no version bump), then the normal hybrid search on the derived words with an optional category narrowing at
confidence >= 0.6. The image is never stored; storing it would need explicit consent plus a retention policy
(`docs/compliance/retention-schedule.md`). Changes: the panel now offers **Take a photo** (`accept="image/*" capture="environment"`, opens the rear
camera on phones) and **Choose from gallery**, the entry button is named "Search by image", and strings exist in all 8 web locales.

## 4. Voice search (existing pipeline, gaps closed)

Unchanged and reviewed: MediaRecorder only after a user gesture, microphone permission explained in the consent notice before the first prompt,
feature hidden without MediaRecorder/getUserMedia, 15 s cap, `/api/search/voice` -> `ai.transcribe` with the UI locale as language hint,
audio processed in memory and dropped. Gap closed: the retention schedule now documents that search audio and photos are processed in memory and
never stored, and what would be required to keep them.

## Decisions

- Synonym variants lead the variant list; the cap is `MAX_VARIANTS + 4`.
- Equivalence groups only (no one-way rules) because query-time expansion never rewrites; Solr `=>` rules are imported as equivalence.
- Judgements live in the database keyed by title slug; the committed fixture stays a file (reviewable, deterministic).
- `@cnote/live-db` is a DEV dependency of `@cnote/search` (and `check-boundaries` ALLOWED_DEPS lists it) only for `relevance/corpus.ts`, outside `src/`.
- Navigation: one "Search tuning" admin entry with Synonyms and Relevance judgements tabs.
- No cookie/consent change: the voice-consent flag already exists in the registry; the policy version is not bumped.

## Design research (Mobbin)

- Fabric, "Take Picture / From Photos" sheet from a camera icon in the search field (https://mobbin.com/screens/f5d4a93a-ab48-4d7e-8f80-e758236578db): adopted the two-option camera vs gallery split.
- Shopee, camera view with "Search from Album" (https://mobbin.com/screens/ec47a1b5-1d3b-41c0-8968-d5230114adb0): adopted album as an explicit alternative.
- eBay, camera icon inside the search field (https://mobbin.com/screens/82be7f0e-d901-4b7f-9e6c-c10135400d73): icon placement beside the field.
- Meta AI listening state with Stop (https://mobbin.com/screens/fca8709b-7a3a-4ce9-995d-3bd6677c5dd4) and Microsoft Copilot "I'm listening"
  (https://mobbin.com/screens/dde18761-b196-4a1d-919e-10fbe3421871): adopted a plain-text listening state plus an explicit stop control (text and `aria-pressed`, not colour).

## Accessibility (WCAG 2.2 AA)

Real buttons with names, 44 px targets, visible focus, `aria-pressed` for recording, one polite `role="status"`, native file inputs inside labels, no
information by colour alone. `e2e/a11y/search-voice-photo.spec.ts` (en + hi, desktop and mobile projects) covers axe with the consent and photo panels open, keyboard
opening, target sizes, the camera `capture` input and a stubbed record/transcribe and photo flow. Not run by the author (the lead runs Playwright serially).
