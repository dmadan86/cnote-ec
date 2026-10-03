# ADR-043: AI eval gate: golden sets, prompt manifest, shadow mode, protected live evals

**Status:** Accepted (records decisions already implemented in PR #20 and the CI hardening in PR #37; operating guide in `docs/guides/ai-evals.md`)
**Note:** Implements the "gate prompt or model changes on golden-set evals" clause of ADR-008 and the plan-invariance promises of ADR-005 and ADR-009.

**Context.** ADR-008 says prompt and model changes are gated on golden-set evals and that every AI decision is logged, but nothing enforced it: a prompt could be reworded, or a model id changed, with no measurement. Real-provider evals cost money and need an API key, which must not be exposed to arbitrary pull requests.

**Options.**
1. Manual evals before releases.
2. Run live evals on every PR with a repository secret.
3. A layered gate: deterministic offline checks on every relevant PR, a committed baseline, live evals behind a protected environment, plus a shadow mode for promoting candidates on real traffic.

**Decision.** Option 3.
- **Golden sets** live in `packages/ai/evals/data/*.json` (synthetic text only, no PII; moderation cases carry a verdict and, for blocks, class flags; Hinglish, Devanagari, mixed-script and obfuscated slices; hard negatives next to every block; injection canaries). `packages/ai/test/evals.test.ts` enforces hard floors on every `pnpm test` with the offline heuristic provider.
- **Prompt manifest.** `packages/ai/prompts.manifest.json` records, for each Anthropic-facing system prompt, its version string and a sha256 of its text (including the shared injection guard), plus the sorted list of `claude-*` model ids. `eval:manifest` fails when prompt text changes without a version bump, when the manifest is stale, or when a model id is added or removed. **A prompt text change therefore needs a version bump, a refreshed manifest and a live baseline.** New system prompts must be registered in `evals/prompt-manifest.ts` (a test checks).
- **Baselines and tolerances.** `evals/baseline/<provider>.json` holds a run report plus optional per-metric tolerance. Defaults allow small drops in quality, auto-accept error rate and review rate, and cap latency and cost growth. `heuristic.json` is committed; **`anthropic.json` is not yet committed** because it needs a real run with a key. `--update-baseline` refuses a run that breaches a hard floor.
- **Workflow** (`.github/workflows/ai-evals.yml`): the offline gate (manifest and heuristic eval) runs on PRs touching `packages/ai` and nightly. The live Anthropic job runs nightly, on manual dispatch and on PRs that change a prompt or model id, in the protected **`ai-evals` GitHub environment** (required reviewers, `ANTHROPIC_API_KEY` stored as an environment secret, never a repository secret). Fork PRs never receive secrets. Without a key, a PR that changes a prompt or model fails with instructions unless it also refreshes the committed anthropic baseline, in which case it warns and a reviewer checks that the numbers are real.
- **Shadow mode.** `AI_SHADOW_PROVIDER` (and `AI_SHADOW_MODEL_REASONING` / `AI_SHADOW_MODEL_FAST`) runs a candidate beside the live provider for `intent`, `extract`, `extract_image` and `moderate`. Results are logged to `AiDecision` with `shadow = true` and `shadow_of_id`, never reach users, never create a `ReviewItem`, and failures are stored as rows. `eval:shadow` compares agreement, missed blocks, review rate and p95 latency. Promotion requires no missed blocks, high agreement, a flat review rate and a passing golden-set eval on the candidate.
- **Plan invariance.** Property tests (`packages/search/test/plan-invariance.props.test.ts`, `packages/enquiry/test/matching-plan-invariance.test.ts`) prove plan, ad spend and sponsorship never change organic rank or lead matching order, and grep the ranking sources for plan or billing identifiers so a paid input cannot be wired in unnoticed.

**Rationale.**
- Text hashing turns "someone edited a prompt" into a failing check without reading diffs.
- The protected environment lets the key be spent only after a human looks at the PR diff, since a PR can change the eval scripts it runs.
- Shadow mode answers "is the new model better on our traffic" without exposing users, at the cost of doubled spend for a bounded window.

**Consequences.**
- Until `anthropic.json` is committed, a PR that changes a prompt or model id cannot pass the live check unless a maintainer runs it with a key.
- The `ai-evals` environment must be created and protected in repository settings; a file cannot do that. Until then the live job runs without the review gate.
- Live runs cost about 130 provider calls; prices in `evals/metering.ts` must be updated when models or prices change.
- Golden sets need growth as new capabilities and attack patterns appear.

**Review.** When a capability or model is added, after the first committed anthropic baseline, and quarterly for tolerance drift.
