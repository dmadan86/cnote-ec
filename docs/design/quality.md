# Quality checks: CV pre-dispatch photo verification (ADR-015)

Status: pilot, behind `QUALITY_CHECKS_ENABLED` (default off). Package `@cnote/quality`, capability `inspectDispatch` in `@cnote/ai`.

## Principles

- **Advisory evidence, never pass/fail (ADR-015, ADR-013).** Results say `consistent | inconsistent | inconclusive` per check with a confidence and a note. Nothing gates dispatch, payment or a dispute outcome. Every view carries `advisory: true`; `listChecksForOrder` adds a disclaimer string.
- **One structured category first.** A category runs only if it is in `QUALITY_CHECK_CATEGORIES` (deploy-time pilot/evaluation) or enabled in `quality_categories` (gated). Seller photos are optional.
- **Expansion needs evidence.** `setCategoryEnabled()` refuses to enable a category unless staff-label accuracy is strictly above `QUALITY_MIN_ACCURACY` (0.9) with at least `QUALITY_MIN_LABELS` (50) labels. The first category ever enabled is the pilot and needs no labels (none can exist). The row stores accuracy, label count and who enabled it; the admin action wraps the call in `audited()` (`quality.review`).
- **Privacy (ADR-010, DPDP).** Photos are re-encoded through `processImage` (EXIF, GPS, ICC stripped, orientation baked in), stored only in the PRIVATE bucket at `quality/<checkId>/<mediaId>.jpg`, read through authenticated routes (owning seller, or staff with `quality.review`), and deleted after 180 days by `purgeOldQualityMedia` (rows and results are kept). The AI decision log holds hashes, sizes, dimensions and the redacted expectation, never bytes; notes are PII-redacted.

## Flow

1. Seller opens `/orders/[id]` (seller app). `DispatchPhotosPanel` calls `getSubmissionContext`: hidden unless the flag is on, the actor is the seller, the order category is allowed, and the order status is recorded/confirmed/dispatched (before or at dispatch). At most 3 photo sets per order, 1 to 4 photos each, 10 submissions per person per hour.
2. The checklist is derived from the order (quantity/unit), the enquiry requirement and the seller's best-matching listing attributes (through enquiry and catalogue public functions; `OrderContextPort` is injectable).
3. `POST /api/quality/[orderId]` validates each image (`validateImage`: magic bytes, size, dimensions), strips and downsizes to 1568 px, dedupes by hash, stores, creates `QualityCheck` (pending) + `QualityCheckMedia`, and enqueues `quality.analyse`.
4. The worker claims the check (pending to analysing, single claimer), calls `ai.inspectDispatch`, then in ONE transaction writes per-check `QualityCheckResult`, completes the check and emits `QualityCheckCompleted`. Retries with backoff; the last failed attempt marks `failed`. A 5-minute job requeues checks stuck in `analysing`.
5. The panel polls while pending and shows results with icon + text (not colour alone).
6. Staff at `/quality` (admin) see photos, expected spec and model result, and record the truth in `QualityLabel`. Accuracy per category = share of labelled results where the model's result equals the label (an `inconclusive` against a definite label counts as wrong).

## AI capability

`inspectDispatch(input, subject)` follows the existing vision pattern: heuristic provider (deterministic, offline, all `inconclusive` at confidence 0.1, always routed to review), Anthropic vision provider (structured output, heuristic fallback on any failure), `AiDecision` logging. Review threshold 0.6 (`INSPECTION_REVIEW_THRESHOLD`; enforced in `inspection.ts` so `decisions.ts` stays untouched). An `inconsistent` verdict also goes to the ops review queue. Verdict rule: any check `inconsistent` at confidence at least 0.5 gives `inconsistent`; all `consistent` gives `consistent`; otherwise `inconclusive`. Prompt version `inspect-dispatch-v1`; changing prompt or model should be gated on the golden set built from `QualityLabel`.

## Data (`quality.prisma`)

`QualityCheck` (order, seller, category, status, verdict, confidence, needsReview, promptVersion, modelId, decisionId, expectedSpec snapshot), `QualityCheckMedia`, `QualityCheckResult` (unique per check+kind), `QualityLabel` (unique per result), `QualityCategory` (allowlist toggle + audit of enablement). No relations to other modules' models.

## Scope decisions

- **Photos only.** Video is not accepted in the pilot: frame extraction needs ffmpeg or a decoder we do not ship, and photos already cover count/label/spec. A later step can extract frames and feed them through the same path.
- **No buyer-web panel.** The buyer sees nothing yet; disputes consume `listChecksForOrder(orderId)` through their own port. A buyer "Seller shared dispatch photos" panel would need 8-locale strings and a WCAG pass and is left for a follow-up.
- **Category comes from the enquiry** (orders carry no listing link); listing attributes are a best-effort title match in that category.

## Design research (Mobbin)

- Airbnb, "Uploading photos" flow: a clear "Add photos" empty state, thumbnail grid with per-photo remove, count-based guidance ("you'll need N photos"). Adopted: thumbnail grid with a labelled remove button and max-photo guidance. https://mobbin.com/flows/11086575-f2e6-4943-8d94-476fb86aa6b1
- Selfridges, "Your photos": each photo labelled by what it must show (front, back, serial number). Adopted: the order-derived checklist (quantity, labelling, product as ordered) shown before upload. https://mobbin.com/screens/ee0d1218-8fdc-4adf-9703-d98772c24c89
- OKX, "Verify your address": bullet requirements above the dropzone, supported types and size limit, and a reassurance line about how the data is used. Adopted: requirement list, type/size limits, privacy line ("location removed, private, deleted after 6 months"). https://mobbin.com/screens/46c2e051-6a3e-48ec-b1a0-d9f9f4464daa

## Env

`QUALITY_CHECKS_ENABLED` (default false), `QUALITY_CHECK_CATEGORIES` (comma slugs), `QUALITY_MIN_LABELS` (50), `QUALITY_MIN_ACCURACY` (0.9). Existing: `AI_PROVIDER`, `MEDIA_DRIVER`, `QUEUE_DRIVER`.
