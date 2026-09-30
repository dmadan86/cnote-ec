# Scale architecture: service extraction, read models, multi-region (ADR-018, ADR-023)

Status: implemented for AI-Orchestration and Search extraction (ADR-018) and for CDC read models (ADR-023); DR tooling and
runbooks in `docs/ops/`. Enquiry and Messaging extraction is deliberately criteria-only (section 2). Everything stays in India
regions (ADR-010).

Principle: **extraction is a deployment change, not a rewrite.** The modular monolith (ADR-006) keeps one code path; a
transport switch decides whether a capability runs in-process or behind HTTP. The default is in-process everywhere, so CI,
local development and small deployments are unchanged.

## 1. What was extracted and how

| Service | App | Client (in the monolith) | Switch | Default |
|---|---|---|---|---|
| AI-Orchestration (ADR-018) | `apps/ai-service` | `packages/ai/src/remote.ts` | `AI_TRANSPORT=inproc\|http` | `inproc` |
| Search query API (ADR-018, ADR-009) | `apps/search-service` | `packages/search/src/remote.ts` | `SEARCH_TRANSPORT=inproc\|http` | `inproc` |

Both services are stateless Hono processes (Node today; the HTTP contract is language neutral so the AI service can be
re-implemented in Python for GPU workloads without touching a caller). Both run the **in-process implementation** of their
package and refuse to start with the transport set to `http` (they would call themselves).

### 2. Where the seam is (what crosses the wire)

- **AI: the provider call, not the capability.** `scoreIntent`, `extractListing`, ... stay in `@cnote/ai` and keep writing the
  `AiDecision` (redacted input, model id, prompt version, latency), applying review thresholds and enqueuing `ReviewItem`s
  (ADR-008). Only `provider.score(input) -> ProviderResult` goes over HTTP. Consequences: the service needs **no database**,
  is the single egress point to model vendors (one place for vendor keys, egress allow-list and PII controls), and decision
  logging cannot be lost or duplicated by a network failure.
- **Search: the read path only.** `searchListings` and `suggest` are exposed. Indexing remains event-driven through the outbox
  (`packages/search/src/indexer.ts`, ADR-007) and is not part of the API.

### 3. Contracts

Machine readable: `docs/design/ai-service.openapi.json`, `docs/design/search-service.openapi.json` (generated from the same
capability table the client uses: `pnpm --filter @cnote/ai-service openapi`, `pnpm --filter @cnote/search-service openapi`; CI
fails when they drift).

**Authentication.** Short-lived service tokens: HS256 JWT, `aud` = `ai-service` | `search-service`, `iss` = caller
(`SERVICE_NAME`), `exp` <= 300 s (default 60 s), `jti`, 5 s clock skew. Secret from env (`AI_SERVICE_TOKEN_SECRET`,
`SEARCH_SERVICE_TOKEN_SECRET`); a comma list `new,old` rotates keys with zero downtime (sign with the first, verify with all).
A token minted for one service is rejected by the other (audience). Network policy is the second lock
(`infra/k8s/base/network-policy.yaml`).

**Endpoints.**

| AI service (POST, body `{ "input": ... }`, answer `ProviderResult`) | Retry-safe |
|---|---|
| `/v1/score-intent`, `/v1/extract-listing`, `/v1/extract-listing-from-images`, `/v1/moderate`, `/v1/extract-document`, `/v1/inspect-dispatch` | yes |
| `/v1/brief-dispute`, `/v1/draft-quote`, `/v1/normalise-quotes`, `/v1/propose-counter`, `/v1/embed` (`{texts[<=256]}` -> `{vectors, version}`) | yes |
| `/v1/transcribe` | **no**: metered per audio second; the queue consumer owns retries |

Search: `POST /v1/search` (`{q, categorySlug?, limit?, cursor?}` -> `{hits, tookMs, nextCursor?, facets?}`), `GET /v1/suggest?prefix=&limit=`.
Both: `GET /health` (liveness), `GET /ready` (config + dependencies; 503 when shedding load), `GET /openapi.json`.

**Wire rules.** JSON only. Binary (images, audio) is `{"$base64": "..."}` anywhere in the input; body cap 24 MiB. Every
response carries `X-Request-Id` (client sends one; the service echoes or generates). Errors: `{"error":{"code","message","requestId"}}`
with 401 (token), 413, 422 (input rejected), 500/503 (retryable). Logs are one JSON line per request (caller, path, status,
latency) and **never contain payloads** (personal data, ADR-010).

**Resilience (caller side).**

| Knob | AI | Search |
|---|---|---|
| Timeout | `AI_SERVICE_TIMEOUT_MS` (15 s: vendor calls) | `SEARCH_SERVICE_TIMEOUT_MS` (2.5 s: interactive, ADR-009 < 2 s) |
| Retries (idempotent only) | `AI_SERVICE_RETRIES` = 2, backoff 150 ms x 2^n | `SEARCH_SERVICE_RETRIES` = 1, backoff 50 ms |
| Circuit breaker | 5 consecutive failures -> open 30 s -> one half-open probe | same |
| Fallback when unavailable | in-process heuristic, result tagged `provider: "heuristic-fallback"` (`AI_REMOTE_FALLBACK=heuristic\|none`) | in-process search (`SEARCH_REMOTE_FALLBACK=inproc\|none`) |
| Never falls back on | 4xx (bad credentials/input are bugs to surface), transcription (an ASR mock must not masquerade as a transcript) | 4xx |

The service sheds load with `503 + Retry-After: 1` above `AI_SERVICE_MAX_INFLIGHT` / `SEARCH_SERVICE_MAX_INFLIGHT`, which the
client treats as unavailability; the HPA scales on CPU (`infra/k8s/base/ai-service.yaml`, 2..20 replicas).
The fraction of `heuristic-fallback` decisions in `ai_decisions.provider` is the health signal of the AI service seen by the
product; alert on it (section 6).

**Compatibility rules.** Add optional fields freely; never rename or repurpose one; a breaking change is a new path
(`/v2/...`) served side by side until every caller has moved. The contract test suite
(`apps/ai-service/test/contract.test.ts`) asserts in-process === over-HTTP for every capability with the deterministic
heuristic providers, and can target another implementation:
`AI_CONTRACT_URL=http://python-svc:8000 AI_CONTRACT_SECRET=... pnpm --filter @cnote/ai-service test contract`.

## 4. Extraction decision criteria (when to split a module)

Extract when at least one **load** trigger and one **ownership** trigger hold, or any **safety** trigger holds. Measure with
`@cnote/metrics` (success metrics), the `domain_events` log and infra metrics.

| Trigger | Threshold to act |
|---|---|
| Load: module CPU/memory share of the busiest deployable | > 40% of a monolith replica's CPU for a week, or it forces > 2x scale-out of everything else |
| Load: latency isolation | module p95 degrades the p95 of unrelated routes (shared event loop) by > 20% at peak |
| Load: hardware shape | needs GPU/large memory/different runtime (AI: Python, GPU) |
| Ownership: team | a dedicated team (>= 3 engineers) owns it and releases more than twice a week independent of the monolith |
| Ownership: release coupling | > 25% of monolith deploys are blocked or rolled back because of this module's changes |
| Safety: blast radius/compliance | a failure or dependency must not stop core flows (vendor egress, PII boundary) |
| Anti-trigger | the module needs the caller's DB transaction (Billing `consumeCredit` joins the caller's transaction, ADR-006) -> keep in the core until the PA integration stabilises (ADR-018) |

Status against the criteria:

- **AI-Orchestration: extracted.** Safety trigger (single vendor egress, PII boundary, independent scaling/runtime).
- **Search: extracted (read path).** Load trigger (query fan-in from web, api and seller) and independent scaling from writes.
- **Enquiry and Matching, Messaging: not extracted.** They need the caller's transactions (credit consumption, outbox rows).
  Preconditions before extraction: (1) replace `billing.consumeCredit(tx)` with a reservation/saga (`ReserveCredit` ->
  `CreditConsumed | CreditRefunded` events), (2) an owning team, (3) sustained load trigger. Until then they scale as replicas
  of the monolith.
- **Billing/Ledger: stays in the core** (ADR-018).

## 5. Rollout

1. **Deploy idle.** Ship the service with no caller (`AI_TRANSPORT` unset). Verify `/ready`, run the contract suite against it.
2. **Shadow (mirrored traffic).** The AI capabilities are pure functions of their input, so mirroring is side-effect free: mirror
   a sample of production requests to the new implementation (service-mesh mirror, or a temporary second URL) and compare
   `output`/`confidence` with the serving implementation offline. Required before swapping a new implementation (for example
   the Python port) behind the same contract; go/no-go = golden-set evals (`packages/ai/evals`) pass and >= 99% agreement on
   the decision-relevant fields (verdicts, scores within tolerance) over a week.
3. **Canary.** Flip `AI_TRANSPORT=http` / `SEARCH_TRANSPORT=http` on the smallest deployable first (the `worker`, whose queue
   consumers tolerate retries), then one `api` replica group (Kubernetes: a second Deployment with the env override at 5-10%
   of replicas), then web/seller/admin. Watch: p95 of the capability at the caller, breaker-open events, `heuristic-fallback`
   share, 5xx on the service.
4. **Promote and keep the escape hatch.** The in-process path remains the fallback and the rollback: set the env back to
   `inproc` and restart; no data migration is involved.
5. **Shrink.** Once stable, callers can drop AI vendor credentials (only the service needs `ANTHROPIC_API_KEY`).

Rollback signal: breaker open > 1% of calls for 10 minutes, or `heuristic-fallback` > 5% of decisions for 15 minutes.

## 6. CDC read models (ADR-023)

`packages/analytics` projects the domain event log (ADR-007) into denormalised tables so analytics never scans OLTP tables:

| Projection | Tables | Answers |
|---|---|---|
| `refs` | `analytics_refs` | enquiry -> match -> conversation lineage (category, seller, buyer); frozen seller state |
| `funnel` (needs `refs`) | `analytics_funnel_daily` | enquiries, scored, matched, accepted, declined, expired, refunded, conversations, quotes, deals won/lost per IST day and category |
| `gmv` (needs `refs`) | `analytics_gmv_daily` | reported off-platform GMV and on-platform order GMV (paise) by category and seller state |
| `seller_cohorts` | `analytics_seller_*` | seller cohort retention by month: active sellers, listings published, leads accepted, quotes sent |

Design properties:

- **Exactly-once effect, resumable.** A projection reads `domain_events` by id range and applies the batch plus advances its
  row in `analytics_checkpoints` in one transaction, holding `FOR UPDATE SKIP LOCKED` on that checkpoint. Crash, retry, or any
  number of workers: no double counting (tested with a failing batch and 3 concurrent runners).
- **Gap safety.** Only events older than `ANALYTICS_LAG_MS` (30 s) are consumed, so a transaction that took a lower id but
  commits later cannot be skipped. Set it above the longest write transaction.
- **Replay safe.** Read models are disposable: `pnpm --filter @cnote/analytics backfill --reset funnel` wipes the projection
  (and dependents) and re-reads from event 0; the result equals the incremental one (tested). Seller state is resolved once and
  frozen so history does not move when an address changes. A projection version bump refuses to run until reset.
- **Lag is observable.** `backfill --status` prints checkpoint and lag per projection (`getProjectionStatus()`).
- **Not on the Redis stream on purpose.** The stream is at-least-once and unordered on redelivery; the log is the source of truth
  and gives ordering plus replays for free. Regional move: point the analytics job at a Postgres read replica (`live-db`/replica
  URL) when the read load matters.

Worker wiring (lead): add `import { worker as analytics, setBusinessStateResolver } from "@cnote/analytics"` to
`apps/worker/src/index.ts`, append `analytics` to `modules`, and register the state resolver
(`setBusinessStateResolver(async (ids) => new Map([...(await getTrustProfiles(ids))].map(([id, p]) => [id, p.state])))`).

## 7. Multi-region

Second India region for DR (Mumbai `ap-south-1` primary, Hyderabad `ap-south-2` standby), active/passive, RPO <= 60 s,
RTO <= 30 min. Details, drills and commands: `docs/ops/dr-runbook.md`, `docs/ops/backup-restore.md`, `docs/ops/deploy.md`.
Active/active is intentionally out of scope: the outbox relay, schedulers and the single-writer Postgres make active/passive
the honest design until Enquiry/Messaging are extracted with their own stores.

## 8. Data residency invariants (ADR-010)

- `DATA_RESIDENCY_ENFORCE=true` in **both** regions; `assertIndiaResidency()` runs in every service including the new ones.
- Backups (`repo1`, `repo2`), object replication, replicas and DNS targets are India regions only (`pnpm ops:dr-check` verifies
  the region pair is two different India regions and that primary and secondary stores pass the residency guard).
- Cloudflare R2 cannot be pinned to India: personal data (KYC, voice) uses an India-region S3-compatible bucket with
  cross-region replication; R2 only for public, non-personal media with `DATA_RESIDENCY_R2_ACK`.
- ai-service egress: only redacted text leaves (redaction stays in `@cnote/ai`), and the vendor endpoint must be India-region or
  covered by DPDP cross-border terms; the residency report flags any non-heuristic `AI_PROVIDER`.

## 9. PA licence decision note (ADR-012 revisit, input to ADR-023)

ADR-012 chose the partner-PA route for Phase 2 and asks to re-evaluate applying for our own Payment Aggregator licence "based
on volume". This note fixes what to measure and when the decision is due, so it is a review of numbers, not an opinion.

Measure (all derivable from the event log; escrow events carry paise amounts):

| Metric | Source |
|---|---|
| Escrowed GMV per month (`EscrowFunded.amountPaise`), released GMV (`EscrowReleased`) | `domain_events`, `analytics_gmv_daily` for the order-side view |
| Escrow attach rate (escrowed orders / matched leads), ADR-012 target >= 20% | `@cnote/metrics` |
| Platform escrow fee income (`feePaise` on `EscrowReleased`) at the ADR-012 1-2% take rate | `domain_events` |
| Partner cost (per-order fee + fixed) and partner SLA breaches (payout latency target < 1 business day) | finance + `PayoutSettled.latencyMs` |
| Dispute and fraud rates (`DisputeResolved`, fraud < 0.5%) | `@cnote/metrics` |

Decision rule (illustrative, tune with finance and counsel): begin the licence workstream when, for two consecutive quarters,
trailing-3-month escrowed GMV annualised x (our fee rate - partner's share of it) exceeds the fully loaded annual cost of
owning the licence (compliance team, audit, capital lock-in, technology/security certification) with at least 2x headroom, **or**
the partner is a binding constraint (payout latency or availability SLA missed in two consecutive months, or commercial terms
that cap growth). Below that, stay on the partner route.

Constraints to check with counsel before the decision meeting (do not rely on this note for regulatory facts): the RBI Payment
Aggregator Master Direction (Sep 2025) referenced in ADR-012, including the net-worth requirement for non-bank PAs, escrow
account and nodal rules, and the 12-18 month authorisation timeline; whether the escrow-like flow qualifies as PA activity at
our structure; and the technology/audit and data-localisation obligations, which coincide with ADR-010 (payment data stays in
India). Review date: first quarterly review after the first month of live escrow volume, then quarterly. The decision (apply /
stay / renegotiate partner) is recorded as a superseding ADR.

## 10. Environment variables added

| Variable | Used by | Default |
|---|---|---|
| `AI_TRANSPORT` | ai package (all callers) | `inproc` |
| `AI_SERVICE_URL`, `AI_SERVICE_TOKEN_SECRET` | callers; the secret also configures the service | required for `http` |
| `AI_SERVICE_TIMEOUT_MS`, `AI_SERVICE_RETRIES`, `AI_SERVICE_BACKOFF_MS` | callers | 15000, 2, 150 |
| `AI_REMOTE_FALLBACK` | callers | `heuristic` (`none` to propagate) |
| `AI_SERVICE_MAX_INFLIGHT`, `AI_SERVICE_MAX_BODY_BYTES`, `PORT` | ai-service | 64, 25165824, 3005 |
| `SEARCH_TRANSPORT`, `SEARCH_SERVICE_URL`, `SEARCH_SERVICE_TOKEN_SECRET` | search package | `inproc` |
| `SEARCH_SERVICE_TIMEOUT_MS`, `SEARCH_SERVICE_RETRIES`, `SEARCH_SERVICE_BACKOFF_MS` | callers | 2500, 1, 50 |
| `SEARCH_REMOTE_FALLBACK` | callers | `inproc` |
| `SEARCH_SERVICE_MAX_INFLIGHT`, `PORT` | search-service | 128, 3006 |
| `SERVICE_NAME` | callers (token `iss`) | `cnote` |
| `ANALYTICS_LAG_MS`, `ANALYTICS_BATCH_SIZE` | analytics job | 30000, 500 |
| `DR_*` | `pnpm ops:dr-check` | see `docs/ops/dr-runbook.md` |
