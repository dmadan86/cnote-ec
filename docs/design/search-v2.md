# Search v2: cross-script, voice, photo, geo-aware ads, measured relevance

Implements the ADR-009 gaps against ADR-004 (Bharat-native: vernacular, Hinglish, mixed-script, low bandwidth),
ADR-008 (all AI through `@cnote/ai` capabilities) and ADR-010 (voice and photos are personal data).

## 1. Cross-script lexical retrieval

`packages/search/src/translit/` (pure, deterministic, no dependencies).

- `indic.ts`: one transliterator for Devanagari (hi, mr), Bengali, Gujarati, Tamil, Telugu and Kannada. The six scripts share the
  ISCII code-point layout, so a character maps to its Devanagari-equivalent by block offset and one ISO 15919-ish table serves all.
  Layers: `toRoman` (strict, diacritics, reversible for Devanagari), `colloquial`/`romanVariants` (the ASCII spellings buyers type:
  schwa deletion for Indo-Aryan scripts, long vowels doubled, v/w, flap ड़ as d or r, Tamil intervocalic voicing) and `fromRoman`
  (Latin, plain or ISO, to Devanagari; plain t/d read as retroflex because English loanwords dominate B2B queries).
- `lexicon-data.ts` / `lexicon.ts`: ~215 trade terms as data (English, Hinglish, hi, mr, gu, kn, ta, te, bn). Add rows freely;
  first row wins on a shared form. Real vocabulary should be mined from listings and search logs and merged here.
- `variants.ts` `expandQuery(text)`: up to 6 EXTRA strings (English via lexicon, transliteration spellings, Hinglish, Devanagari).
  The original text is never replaced, the embedding is still built from the original only, and `SEARCH_TRANSLIT=off` disables it.
- Wiring: `searchListings` -> `SearchIndexQuery.variants` -> Postgres (`retrieveListings`: an OR of AND-of-word queries scored 1.5x,
  below the buyer's own words 2x, above the loose any-term match; exact word forms plus `s`/`-s`, never prefixes, so "batte" cannot
  match "battery") and OpenSearch (`bool.should` of `multi_match`, boost 0.6). Cache key bumped to `v4` and includes the flag.
- Two pre-existing bugs fixed on the way: `normaliseQuery` and the FTS tokenizer dropped Indic vowel signs (`\p{M}`), so Hindi
  words were cut into fragments; Hindi/Marathi filler words (`चाहिए`, `के लिए`, ...) are now removed.

## 2. Voice search

`POST /api/search/voice` (multipart: `audio`, `lang`, `consent=1`). Per-IP limit 12/min, fails closed if Redis is down, 1.5 MB cap.
`@cnote/ai` `transcribe` with the UI language as hint (Sarvam or the mock provider by `ASR_PROVIDER`). Audio lives in memory for the
request only; the AiDecision keeps a hash, size and the redacted transcript. Response is `private, no-store`.
UI (`features/search/search-tools.tsx`): mic button in the search bar, first use shows the notice and asks to agree
(remembered in `localStorage`, storage failures just re-ask), press-and-hold or tap-to-start/tap-to-stop, 15 s cap, microphone released
immediately, transcript fills the query and is announced. Hidden without JS or MediaRecorder.

## 3. Search by photo

`POST /api/search/image` (multipart: `image`, `lang`, `cf-turnstile-response`). Per-IP limit 6/min, Turnstile via `verifyHuman`
(dev adapter outside production without a secret, fails closed in production), `@cnote/media` `validateImage` (magic bytes, 5 MB,
200-6000 px), re-encoded in memory by `processImage` (drops EXIF/GPS/ICC, max 960 px), then the new `@cnote/ai` capability
`deriveImageSearch` (reuses `extractListingFromImages`, so the same prompt/model/eval gate and AiDecision audit) turns the result into
keywords plus a category guess. Category only narrows results when confidence >= 0.6. The client also downscales to 1280 px on the
device (low bandwidth, and it drops EXIF before upload). Results page shows "Results for photo: <words>" with a plain GET edit form.

## 4. Geo-aware sponsored slots

`loadSponsoredForResults` reads the "Deliver to" cookie (`cnote_pincode`) and passes `buyerPincode` and a derived `buyerState`
(`features/search/geo.ts`, India Post prefix table) to `getSponsoredSlots`. Unknown location matches only unrestricted campaigns.

## 5. Relevance evaluation

`packages/search/eval/judgements.json`: 80 graded queries (25 English, 20 Hinglish, 14 Hindi, mixed script, kn/ta/te/gu/bn/mr) over
stable product-line slugs (the slug of each seed template's first title). It describes the DUMMY seed; real catalogue data will
replace it and the queries should then be re-judged from real logs. `pnpm --filter @cnote/search eval` computes nDCG@10, MRR and
hit-rate@10 with and without variants. Metric math is unit-tested (`test/eval-metrics.test.ts`).

## Design research (Mobbin)

Consulted before the voice/photo UI:
- Magnific, "Searching with image" flow (https://mobbin.com/flows/96d4cd65-bdb7-4393-bf0e-f4298ef7088a): mic and camera icon buttons
  inside the search field, upload as a step, then results. Adopted: both controls live in the search row, photo is an explicit step.
- Cosmos, "Searching by image" (https://mobbin.com/flows/f7400a75-933c-497a-a639-338175022342): visual search panel with "upload a
  file", a busy state, and the query shown back after the search. Adopted: panel + status, and echoing the derived query.
- Microsoft Copilot listening state (https://mobbin.com/screens/12555865-9340-476e-a3ef-bc2f8ccdb8a5): plain-language
  "I'm listening" state with a clear stop control. Adopted: text status and a stop icon (not colour alone).
- Dropbox Dash mic inside the input (https://mobbin.com/screens/151b0b43-dc4d-464f-8e33-daebd2c53199).

## Accessibility (WCAG 2.2 AA, buyer web)

Real buttons with accessible names, 44 px targets, visible focus, `aria-pressed` on the recording toggle, keyboard operable
(Enter/Space toggles; press-and-hold is an alternative, never the only way), one polite `role="status"` region, consent and photo
panels are labelled groups, file input is a real labelled control, controls hidden entirely when unsupported, 15 s recording cap is
announced in the hint. No timing pressure beyond that.

## Operations notes / known gaps

- `next.config.ts` sends `Permissions-Policy: microphone=(), camera=()` for every route (default in `@cnote/security`), which blocks
  voice search in browsers. `/search` (and `/:locale/search`) need `microphone: true` (and `camera: true` if the OS camera picker
  is to work inside the page) in `staticHeaderList`/`securityHeaders`. Not changed here (outside this task's ownership).
- `/search` is served with `public, s-maxage=60`: sponsored slots (per visitor, and now per pincode) must not be shared between
  users by a CDN. Use `private, no-store` when the pincode cookie is present, or load slots client-side.
- Low-confidence transcripts and photo derivations create ReviewItems (ADR-008), which is noisy for search; consider dedicated
  capability keys with their own thresholds.
- Semantic path is unchanged: the hashing embedder is noisy for non-Latin text, which dilutes fusion for Indic-only queries
  (see the per-language numbers). A multilingual embedder, or embedding the lexicon's English variant, is the next step.
