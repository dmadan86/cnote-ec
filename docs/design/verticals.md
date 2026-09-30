# Verticals: expansion playbook and gates (ADR-016)

Package `@cnote/verticals`, schema `packages/db/prisma/schema/verticals.prisma`, admin at `/verticals`. ADR-011 (Phase-1 vertical) is undecided, so everything here is config and data; nothing names a vertical.

## Model
- `Vertical`: slug, name, `stage` (candidate, pilot, open, paused), root `categorySlugs` (descendants included when evaluating), ordered `languages` (subset of the 8 codes), `clusters` (city/district + industry), `gates` (default 200 verified sellers, net adds >= 1 over 30d and 90d), `classifierConfig` (prohibited/intent model version pointers only, no training here), `attributeSchemaSlug` (catalogue category whose schema governs the vertical).
- `VerticalChecklistItem`: section (schema, classifiers, acquisition, languages, ops, compliance), title, done, owner, evidence URL.
- `VerticalStageChange`: append-only history with override flag/reason and the blocking-gate snapshot.
- `VerticalMetricSnapshot`: one row per vertical per IST day (verified sellers, net adds, gates met). Categories are referenced by slug; no relations to other modules' models.

## Gates
`evaluateVerticalGates(id)` = verified sellers now (tier >= 1, live listing in the vertical's category tree) plus net adds versus a baseline snapshot: the latest snapshot at or before today minus the window, else the earliest earlier snapshot (partial window, reported as `baselineDays`), else `null` and the gate fails. Net adds therefore need the daily job to have run; a fresh vertical cannot pass until it has history.

Seller count comes from a port, `setVerticalStatsPort`. The default implementation composes public functions only: `listCategories` (expand descendants), `listPublicListingIndex` (page the live index), `getPublicListingsByIds` (seller ids), `getTrustProfiles` (current tier). It is correct but walks every live listing; a dedicated aggregate would be cheaper (see wiring note below).

## Expansion rule (server-side)
`changeStage` allows candidate -> pilot -> open, any -> paused, and demotions to candidate. Entering pilot/open (including pilot -> open and resuming from paused) requires every OTHER open vertical to meet its gates. Otherwise it throws `conflict` (with the blocking results in `details`) unless an `override` with a reason of at least 10 characters is supplied. The reason is stored on the stage-change row and in the audited action (`verticals.manage`). The stage update uses a compare-and-set so concurrent moves cannot both succeed. `VerticalStageChanged` is emitted in the same transaction.

## Reads and caching
`listOpenVerticals()` and `getVerticalForCategory(slug)` (walks up the category ancestors; most advanced stage wins) read one cached list (`cachedTagged`, tag `verticals`, 5 min + 15 min stale). Create, update and stage change call `invalidateTags`. `cachedTagged` is the tagged variant of core `cached`, chosen for explicit invalidation.

## Daily job
`verticals.snapshot-gates` (module `verticals`, every 24h) snapshots every vertical, candidates included, so history accrues before launch. Upserts per IST day, so reruns are safe; a failing vertical is logged and skipped.

## Template
`createVerticalFromTemplate` creates a candidate and seeds `PLAYBOOK_TEMPLATE` (mirrors `docs/playbooks/TEMPLATE.md`); `listCandidateRoots` lists non-prohibited root categories for a picker.

## Admin (/verticals)
List: stage badge, gate badge from the latest snapshot (cheap; live evaluation is on the detail page), verified sellers, net adds, checklist progress. Detail: live gate table, 30-day trend table with relative bars, stage form with override reason and history, checklist by section with owner/evidence, configuration form. All mutations run through `audited()` with `verticals.manage`.

## Design research (Mobbin)
- Checklist with progress count and per-item state: [Klaviyo setup guide](https://mobbin.com/screens/bbe25921-6fd3-48d8-94fd-11a288886df9), [HoneyBook setup](https://mobbin.com/screens/7c915d6b-2a99-4eb0-956d-e7a3a97bb265). Adopted: "n/m completed" in the section headers, done items struck through.
- Health metrics with status badges ("Healthy"/"Needs attention"): [Klaviyo deliverability](https://mobbin.com/screens/3d1f5b33-f01c-4abc-bd9a-7cdee2509095). Adopted: met/not met badges per gate.
- Trend over time: [Sweatpals RSVPs](https://mobbin.com/screens/559f92b3-65d0-4fdb-acfc-effa56737ae6). Adopted: a simple daily trend (table with bars, no chart dependency).
- Staged rollout with an explicit state change: [Shopify rollout](https://mobbin.com/screens/ec3bc76f-7f80-4bde-8a23-2f108149f0e0). Adopted: stage change as a deliberate form with a required reason when bypassing the guard.

## Wiring left to the lead
- `apps/worker/src/index.ts`: register `worker` from `@cnote/verticals`.
- Admin nav entry to `/verticals` (privilege `verticals.manage`).
- Optional: add to catalogue or identity a public aggregate `countVerifiedSellersInCategories(categorySlugs, minTier)` and call it from the port with `setVerticalStatsPort`.
