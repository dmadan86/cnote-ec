# Vertical playbooks as data (ADR-011, ADR-016)

Companion to `docs/design/verticals.md` (expansion gates) and `docs/adr/ADR-011-vertical-selection.md` (the recommendation). A playbook is the Phase-1 vertical's category tree, attribute schemas, units, HSN codes and regulatory flags, expressed as validated data in `@cnote/verticals`. It is **off by default**: nothing reads it until someone loads it.

## Where things live

| What | Where |
|---|---|
| Playbook schema (zod) | `packages/verticals/src/playbook/schema.ts` |
| Packaging (Bengaluru) data | `packages/verticals/src/playbook/packaging-bengaluru.ts` |
| Registry, mapping, `loadPlaybook` | `packages/verticals/src/playbook/index.ts` |
| Proposed golden sets | `packages/ai/evals/proposed/packaging-bengaluru/` |
| Tests | `packages/verticals/test/playbook.unit.test.ts`, `playbook.db.test.ts` |

## Activation (explicit only)

```bash
pnpm db:seed -- --vertical=packaging-bengaluru --only   # categories + candidate vertical, no dummy data
pnpm db:seed -- --vertical=packaging-bengaluru          # same, then the usual dummy seed
```

`loadPlaybook(key)` upserts categories by slug (idempotent) and creates the vertical as a `candidate` with the ADR-016 checklist. It never changes a stage, so loading cannot open a vertical; the ADR-016 gates still govern pilot/open. Calling it from an admin screen must go through `audited()` (not built here, see "Not done"). A test scans all `packages/*/src` and `apps/*/src` and fails if any file outside `playbook/` mentions the playbook key or its root slug, so the vertical cannot be hard-coded.

## Playbook contents per category

- `attributes`: same field model as the catalogue (`text|number|select`, `required`, `options`, `unit`); units must come from a closed list (`mm`, `gsm`, `micron`, `bf`, `kg`, `ml`, ...) and only on number fields.
- `variantAxes`: attribute keys that define a stockable variant (size, ply, ...). The catalogue has no variant model yet; this is guidance for SKU/bulk upload and for the listing form.
- `units`: allowed price and MOQ units (from `TRADE_UNITS`), defaults, `typicalMoq`.
- `hsn`: primary first, 2 to 8 digits (same rule as listings). 4 and 6 digit heading codes are used on purpose; 8 digit tariff lines were not verified. GST rates are not stored (they change, e.g. corrugated boxes 12% to 5% on 2025-09-22); billing owns rates.
- `regulations`: kind (`bis-qco`, `bis-standard`, `fssai`, `pwm-epr`, `ispm-15`, `un-dg`), standard, `qcoStatus` for BIS entries (`in-force`, `rescinded`, `none-found`, `unverified`), `requiresCertificate`, `verifiedOn`. Rule enforced by the schema: a QCO in force must require a certificate.
- `constraints`: hard numeric rules (e.g. carry bags at least 120 micron, ply 1 to 9).
- `prohibited`: prohibited subcategories (single-use plastics), mapped to `Category.prohibited`.
- `aliases`: Hinglish and transliterated search terms for the vertical.

## How regulatory flags reach the product (and what is not wired yet)

`playbookToCategoryDefs` adds a required `certificate_ref` text attribute to every category whose regulations require a certificate (food-grade packaging, UN-rated dangerous-goods packaging). Today that makes the listing form and `validateAttributes` insist on a certificate or test-report reference. Actual document upload, review and a verified badge are **not** wired: moderation does not yet read `regulations` or `constraints`. The helpers `categoryNeedsCertificate`, `regulationsFor` and `checkPlaybookConstraints` are exported for that integration (see Follow-ups).

## Decisions

1. **Playbook as code-resident data, not DB rows.** It is versioned in git, reviewable, validated at import, and loads idempotently. A DB-managed playbook editor is premature before the vertical is confirmed.
2. **No schema change.** Categories already store attribute schemas and a `prohibited` flag; regulatory metadata, constraints, variant axes and HSN live in the playbook, not in new columns, to avoid a migration for an unconfirmed vertical. No migration was added.
3. **Root slug `packaging-materials` differs from the dummy seed's `packaging-printing`** so loading never overwrites dummy categories.
4. **BIS entries state what was found, not what is hoped.** For corrugated boxes and kraft paper the entry is `bis-standard`, `none-found`, `requiresCertificate: false`, with a note that counsel must confirm. Where I could not source a rule (PWM/EPR, carry-bag thickness, SUP list, UN dangerous-goods regime, jute reservation) the data says `unverified` or carries an explicit note. No QCO-in-force entries exist in the packaging data; the mechanism is covered by schema tests so a later vertical (safety helmets under IS 2925, for example) can use it.
5. **Language order** `hi, en, kn, ta, te` is a hypothesis recorded in the ADR and in the data; interviews decide.
6. **Golden sets are `proposed/`, not committed baselines.** `packages/ai/evals/baseline/heuristic.json` records case counts and the harness reads fixed files in `evals/data/`. Adding cases there changes the counts and the extraction field accuracy denominators, which would fail the baseline comparison and the "prompt or model change needs a refreshed live baseline" CI rule. So the sets sit beside the eval harness untouched.

## Promoting the proposed golden sets

Do this only after the vertical is confirmed, in one PR, with a refreshed baseline:

1. `cd packages/verticals && pnpm exec tsx scripts/export-eval-categories.ts` (regenerates `proposed/packaging-bengaluru/categories.json`; a test fails if it drifts).
2. Append `proposed/packaging-bengaluru/categories.json` entries to `packages/ai/evals/data/categories.json`; append the three other files to `extraction.json`, `intent.json`, `moderation.json` (ids are prefixed `pb-`, so no collisions; a test checks they are not already in `data/`).
3. Run `pnpm --filter @cnote/ai eval -- --provider heuristic`. Cases the heuristic provider cannot do (for example dimension extraction like `300x200x150`) will fail; tag those with `"tags": ["llm-only"]` as the existing sets do, or trim them. Intent bands are first estimates and must be re-calibrated on the heuristic and live runs.
4. `pnpm --filter @cnote/ai eval -- --provider heuristic --update-baseline`, commit the new `baseline/heuristic.json`, and refresh the live Anthropic baseline through the protected `ai-evals` CI environment (ADR-008/043).
5. Delete the promoted files from `proposed/` (keep `categories.json` only if you still want the drift test).

The proposed sets were validated structurally (units, attribute keys and types, select options, HSN prefixes, categories exist) by the unit tests; they were **not** run through the heuristic or live providers in this change.

## Not done / follow-ups

- Admin button to load a playbook (needs `audited()` action and a `verticals.manage` privilege check); today the seed option is the entry point.
- Moderation hook: require `certificate_ref` before auto-approval, apply `constraints`, and route `prohibited` matches to block. This touches `@cnote/catalogue`/`@cnote/ai` and the eval gate, so it is separate.
- Translations of category names and labels into `hi` and `kn`.
- Seller-cluster census and interviews (ADR-011 checklist); legal confirmation of every `unverified` regulation.
