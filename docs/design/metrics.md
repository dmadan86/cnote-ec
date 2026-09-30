# Metrics layer (Phase-1 gate)

Package `@cnote/metrics`; console at `/metrics` in `apps/admin` (privilege `metrics.read`). Implements the
"Metrics" lines of ADR-002, 003, 004 and 005 from the append-only `DomainEvent` log (ADR-007). It reads only
`domain_events` and writes only `metric_daily` and `metric_alerts`.

## How it works

- Days are **IST calendar days**. `metric_daily` is keyed `(metric, day, dimension)`; dimension `""` is overall, `category:<id>` (or `category:none`) is a breakdown.
- **Cohort semantics.** A metric "of day D" is anchored on the cohort event that happened on D; the follow-up event may occur up to *window* days later. A day's value therefore keeps changing until D + window has passed ("matured"). The scorecard's "latest" and all alerts use matured days only.
- `computeDay(day)` replaces each metric's rows for the day in one transaction, so recompute is idempotent and picks up late events. Days with no qualifying cohort get **no row** for rates and medians (never a divide by zero); count metrics store 0.
- Worker (`worker` export, name `metrics`): every 15 min recompute today and yesterday; a job ticking every 20 min runs the nightly pass once per IST day in the 02:00 hour, recomputing the previous 31 days (covers the 30-day deal window). Longer windows (90-day badge revocation) refresh through `backfill`.
- Backfill: `pnpm --filter @cnote/metrics backfill -- --from 2026-09-01 [--to YYYY-MM-DD] [--metric id]`.
- Alerts: raised per (metric, day) when a matured day breaches its rule and the sample size is met; an open alert is refreshed on recompute, a resolved one is never re-opened. Resolving is audited as `metric_alert.resolve`.

## Definitions

Distinct keys are taken from event payloads (`matchId`, `enquiryId`, `businessId`, ...) so duplicate delivery does not double count.

| Metric id | ADR | Formula | Window | Target | Alert (min n) |
|---|---|---|---|---|---|
| `lead_to_conversation_rate` (by category) | 002 | distinct matchId with `ConversationStarted` within 7d / distinct matchId with `LeadMatched` on day | 7d | >= 60% | below 60% (20) |
| `conversation_to_deal_rate` | 002 | distinct matchId with `DealReportedOffPlatform` outcome=won within 30d / distinct matchId with `ConversationStarted` on day | 30d | >= 15% | below 15% (20) |
| `auto_refund_rate` (by category) | 002 | distinct matchId with `LeadRefunded` within 14d / distinct matchId with `LeadAccepted` on day | 14d | < 10% | above 10% (20) |
| `leads_per_enquiry` (by category) | 002 | `LeadMatched` within 2d for enquiries created on day / distinct enquiries with `EnquiryCreated` on day | 2d | none | none |
| `median_lead_response_minutes` | 002 | median(`LeadAccepted.responseMs`)/60000 over accepts on day | 0 | none (SLO 120) | above 120 (5) |
| `enquiry_review_hold_rate` (by category) | 002 | distinct enquiryId whose latest `EnquiryScored.needsReview` is true / distinct enquiryId scored on day | 0 | none | none |
| `t1_plus_seller_share` | 003 | snapshot at end of day: distinct sellers with `BusinessVerified` tier >= 1 / distinct `BusinessCreated` isSeller | 0 | >= 80% | none |
| `false_badge_proxy` | 003 | distinct businessId with `TrustScoreChanged` badgeActive=false within 90d / distinct businessId `BusinessVerified` tier >= 1 on day | 90d | < 0.5% | above 0.5% (50) |
| `time_to_first_listing_median_minutes` | 004 | median minutes from `BusinessCreated` (isSeller) to first `ListingVersionPublished` or `ListingPublished` of that seller, sellers created on day, within 30d | 30d | < 15 min | above 15 (10) |
| `onboarding_completion_rate` | 004 | distinct sellers created on day with a listing published within 7d / distinct sellers created on day | 7d | >= 60% | below 60% (10) |
| `listing_moderation_reject_rate` | 004 | (`ListingModerated` + `ListingVersionReviewed` with status=rejected) / (all of both) on day | 0 | none | none |
| `ugc_approval_rate` | 008 | (`ReviewModerated` + `CommentModerated` status=approved) / (all of both) on day | 0 | none | none |
| `leadgen_verified_to_enquiry_rate` | 002 | distinct captureId with `LeadCaptureConverted` within 7d / distinct captureId with `LeadCaptureVerified` on day | 7d | none | none |
| `leads_accepted`, `enquiries_created`, `orders_recorded`, `subscription_starts`, `subscription_cancels`, `credits_consumed`, `credits_refunded` | 002/005/007 | event count on day | 0 | none | none |

Gate metrics on the scorecard: those with a target above (the first three funnel rates, T1+ share, false-badge proxy, time-to-first-listing, onboarding completion).

## Freshness

Today and yesterday are at most 15 minutes stale. Older days converge nightly for 31 days. Cohort metrics for recent days are provisional (see window column) and are excluded from the scorecard "latest" until matured.

## Known caveats and gaps

- **Off-platform deals are self-reported** (`DealReportedOffPlatform`); conversation-to-deal understates wins that are never reported.
- **Fake-lead precision/recall** and **listing edit rate after AI draft** (ADR-002, ADR-004) need labelled data or edit events that do not exist yet; not computed. `enquiry_review_hold_rate` is only a proxy for the intent model's strictness.
- **T1+ share** is cumulative over all sellers, not "active sellers within 90 days".
- **False-badge proxy** counts any badge switch-off within 90 days, fraud or not; it over-estimates the ADR "verified seller later found fraudulent" rate.
- **OTP conversion**: no OTP-sent event exists in the catalogue; only verified-to-enquiry is derived here. Start-to-verified stays in `leadgen.funnelByTriggerDay`.
- **Email failures** are not domain events, so no email-failure metric.
- **Indexing**: `domain_events` has no `(type, occurred_at)` index (only `(published_at, id)` and `(aggregate_type, aggregate_id)`), so each metric query scans the table. Fine at Phase-1 volumes; add `@@index([type, occurredAt])` to `platform.prisma` (and a migration) when the log grows. Every query already bounds `occurred_at` so it benefits immediately. The T1+ snapshot is unbounded below by design.
- Category breakdown resolves `EnquiryCreated.categoryId` within a 60-day lookback of the cohort day.
