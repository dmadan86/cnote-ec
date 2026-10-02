# AI evals, prompt gate and shadow mode (ADR-008)

ADR-008 says prompt and model changes are gated on golden-set evals, and that every AI decision is logged. This guide is how that works day to day.

## What runs where

| What | When | Provider | Gate |
|---|---|---|---|
| `packages/ai/test/evals.test.ts` | every `pnpm test` / CI | heuristic (offline) | hard floors |
| `eval:manifest` (prompt manifest) | every PR touching `packages/ai`, nightly | none | fails on unbumped prompt change, stale manifest, model-id change |
| `eval --provider heuristic` | every PR touching `packages/ai`, nightly | heuristic | hard floors + committed baseline |
| `eval --provider anthropic` | nightly, manual dispatch, PRs that change a prompt or model | Anthropic | hard floors + committed baseline + latency + cost |
| `eval:shadow` | on demand against production | n/a (reads the `AiDecision` log) | human judgement |

All of it lives in `.github/workflows/ai-evals.yml` except the unit test.

## Running the golden sets

```bash
pnpm --filter @cnote/ai run eval --provider heuristic            # offline, no key
ANTHROPIC_API_KEY=... pnpm --filter @cnote/ai run eval --provider anthropic
pnpm --filter @cnote/ai run eval --provider anthropic --update-baseline   # after reviewing, to accept new numbers
```

Flags: `--out <dir>` (default `packages/ai/evals/reports/`, git-ignored), `--baseline <file>`, `--update-baseline` (refuses to record a run that breaches a hard floor). Exit code 1 means a hard floor was breached or a metric regressed beyond tolerance. A Markdown summary goes to stdout and to `$GITHUB_STEP_SUMMARY`; CI uploads the JSON and Markdown as an artifact.

The anthropic run uses the real provider with the heuristic fallback turned off. A thrown error or a silent fallback counts as a wrong answer and is reported as a provider error, so an outage cannot hide behind the heuristic.

The live run costs money: about 130 calls, mostly on the fast model. The report prints the token usage and a USD estimate per capability from list prices in `evals/metering.ts` (update `PRICES` when prices or models change; unknown models show cost as n/a).

## What the report contains

- **Quality metrics** per capability, each with a hard floor (`THRESHOLDS` in `evals/harness.ts`): intent band accuracy, extraction field accuracy, moderation block precision and recall, flag accuracy (a block must name the right class), block recall on the Hinglish / Devanagari / mixed-script / obfuscated slice, embedding triplets, vision, ASR.
- **Calibration** for intent, extract and moderate against the human-review thresholds in `REVIEW_THRESHOLDS`: review rate, accuracy of auto-accepted decisions (the wrong answers that nobody reviews), accuracy of human-routed decisions, mean confidence, and expected calibration error. Moderation counts a `review` verdict as human-routed whatever its confidence (ADR-003).
- **Latency** p50 and p95 per capability, wall clock per provider call.
- **Cost** tokens and estimated USD per capability and per 1,000 calls.

## Baselines and tolerance

Baselines are `packages/ai/evals/baseline/<provider>.json`, a run report plus an optional `tolerance` object. Defaults (`DEFAULT_TOLERANCE` in `evals/metrics.ts`):

| Check | Default |
|---|---|
| Quality metric may drop | 0.03 absolute |
| Auto-accept error rate may rise | 0.05 |
| Human-review rate may rise | 0.15 (a flooded ops queue is a regression) |
| Provider errors may rise | 0.02 of calls |
| p95 latency (real providers) | 1.5x plus 250 ms |
| Cost per capability (real providers) | 1.25x |

Override a single metric by adding it to the baseline's `tolerance` (for example `"intentBandAccuracy": 0.05` or `"calibration.moderate.reviewRate": 0.25`). Without a baseline for a provider only the hard floors apply and the report says so.

`heuristic.json` is committed. **`anthropic.json` is not yet**: it has to come from a real run with a key. Run the anthropic eval once, read the report, then `--update-baseline` and commit it.

## Golden sets

`packages/ai/evals/data/*.json`. Rules for adding cases:

- Synthetic text only: no real names, phone numbers, emails, URLs or listings. A test rejects obvious PII patterns.
- Moderation cases carry a `verdict` (`allow` | `review` | `block`). A `block` must carry `flags` from the classifier's class list (`pharma`, `narcotics`, `explosives`, `weapons`, `hazardous_chemicals`, `wildlife`, `counterfeit`, `adult`, `tobacco_alcohol`); a test checks every flag is one of those and that every class has at least two blocks.
- `tags`: `hinglish`, `devanagari`, `mixed`, `obfuscated` feed the script-slice recall floor. `llm-only` marks cases a rule engine cannot reasonably get (cryptic Hinglish); the heuristic run skips them, the live run includes them.
- Add hard negatives next to every block case (Mercury Ltd motors, ivory-white paint, injection moulding) so a more aggressive model does not buy recall with false blocks.

## Prompt and model gate

`packages/ai/prompts.manifest.json` records, for each Anthropic-facing system prompt, the version string and a sha256 of the text (including the shared injection guard), plus the sorted list of `claude-*` model ids. `pnpm --filter @cnote/ai run eval:manifest` fails when:

1. a prompt's text changed but its version constant did not (bump `PROMPT_VERSIONS` and friends);
2. the manifest is stale (run the evals, then `eval:manifest --write`; `--write` itself refuses an unbumped prompt change);
3. a model id was added or removed.

A new system prompt must be registered in `PROMPTS` in `evals/prompt-manifest.ts`; a test fails if a `SYSTEM` constant in `src/` is missing.

When a PR changes the manifest, the live job must run: with `ANTHROPIC_API_KEY` set it does; without it (forks, secret not configured) the job fails with instructions unless the PR also refreshes `evals/baseline/anthropic.json`, in which case it warns and a reviewer checks that the numbers are real.

The anthropic provider defaults are `claude-sonnet-5-5` for reasoning capabilities and `claude-haiku-4-5` for cheap ones; override per environment with `AI_MODEL_REASONING` and `AI_MODEL_FAST`.

## Shadow mode

Test a candidate model on real traffic before promoting it.

```bash
AI_PROVIDER=anthropic                       # live provider, unchanged
AI_SHADOW_PROVIDER=anthropic                # candidate provider: anthropic | heuristic
AI_SHADOW_MODEL_REASONING=claude-opus-5-5   # candidate models (optional, default to the live ones)
AI_SHADOW_MODEL_FAST=claude-haiku-4-5
```

After each live decision for `intent`, `extract`, `extract_image` and `moderate`, the candidate runs in the background on the same input. Its result is logged to `AiDecision` with `shadow = true` and `shadow_of_id` pointing at the live decision. It never reaches users, never creates a `ReviewItem`, and its failures are stored as `{ "shadowError": ... }` rows rather than thrown. The candidate has no heuristic fallback, so outages show up as errors. A candidate that would just repeat the live provider and models is skipped. Shadow calls double the model spend for those capabilities; turn it on for a bounded window.

Compare the two from the log:

```bash
pnpm --filter @cnote/ai run eval:shadow -- --hours 24 [--capability moderate] [--json]
```

Per capability it prints pairs, candidate errors, agreement (same moderation verdict, intent score within 10 points, same extracted category and title), moderation missed blocks (candidate allowed what live blocked) and extra blocks, review rate and mean confidence for each side, and p95 latency. Promote only when there are no missed blocks, agreement is high, the review rate does not rise, and the golden-set eval passes on the candidate: set `AI_MODEL_*` to the candidate, run the anthropic eval, bump the prompt version if the prompt changed, update the manifest and the baseline.

Shadow rows are subject to the same 180-day input purge as other decisions.

## Plan invariance

ADR-005 and ADR-009: plan, ad spend and sponsorship never change organic rank, the trust score, or lead matching order. The property tests are `packages/search/test/plan-invariance.props.test.ts` (with `filters.props.test.ts` and `properties.test.ts`) and `packages/enquiry/test/matching-plan-invariance.test.ts`. They also grep the ranking sources for plan or billing identifiers, so wiring a paid input into `fusion.ts`, `filters.ts`, `search.ts`, `trust.ts`, `scoring.ts` or `matching.ts` fails CI even if no value is passed yet.
