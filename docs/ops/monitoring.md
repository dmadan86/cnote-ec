# Monitoring, dashboards and on-call routing

Companion to `dr-runbook.md` and `deploy.md`. Design of the metrics themselves: `docs/design/metrics.md`. Files: `infra/monitoring/grafana/`.

## 1. How data is exposed

There is no Prometheus endpoint. Business metrics are computed by `@cnote/metrics` (worker jobs `metrics.refresh-recent` every 15 min and `metrics.nightly` at 02:00 IST) from the append-only `domain_events` log into Postgres tables:

- `metric_daily(metric, day, dimension, value, numerator, denominator, computed_at)`
- `metric_alerts(metric, day, value, threshold, direction, message, resolved_at)`, raised when a matured day breaches the `alert` rule in `packages/metrics/src/definitions.ts` (with a minimum sample size), shown in admin, resolved in admin.

So the monitoring stack is **Grafana with a Postgres datasource** (SQL panels) plus a **Redis datasource** for queue depth. Platform state comes from `domain_events.published_at` (outbox) and Redis streams. Errors and traces are in Sentry (ADR-039). A Prometheus/OTLP pipeline is a follow-up (no service exports process metrics yet), so there are no Prometheus rule files; alert rules use Grafana unified alerting, whose evaluation of SQL is equivalent.

## 2. Setup

1. Create a read-only DB role on the **read replica** (India region only, ADR-010): `CREATE ROLE grafana_ro LOGIN PASSWORD '...'; GRANT CONNECT ON DATABASE cnote TO grafana_ro; GRANT SELECT ON metric_daily, metric_alerts, domain_events, escrow_payouts, escrow_reconciliation_issues, ondc_orders, ad_clicks TO grafana_ro;` Do not grant on tables holding personal data. The dashboards read no PII (`ad_clicks` panels use only aggregates).
2. Run Grafana (self-hosted in an India region; Grafana Cloud is not acceptable unless its region and DPA are approved). Install the `redis-datasource` plugin.
3. Provision, with env vars `CNOTE_PG_REPLICA_HOST`, `CNOTE_PG_RO_PASSWORD`, `CNOTE_REDIS_URL`, `PLATFORM_ONCALL_WEBHOOK_URL`, `FINANCE_OPS_WEBHOOK_URL`, `PRODUCT_OPS_WEBHOOK_URL`:
   - datasources: `infra/monitoring/grafana/datasources.json` (uids `cnote-pg`, `cnote-redis`)
   - dashboards: `infra/monitoring/grafana/provisioning.yaml` pointing at `infra/monitoring/grafana/dashboards/*.json`
   - alerting: `infra/monitoring/grafana/alerting/rules.json` (rules) and `routing.json` (notification policy + contact points)
4. Replace `CHANGE-ME` in the Sentry links (platform dashboard) and in `runbook_url` annotations with the org slug and repo URL.
5. The DLQ panel/rules use Redis key `cnote:q:<topic>:dlq` (see `packages/core/src/queue/redis.ts`). Add new `JobTopics` to the panel when they are declared.

Dashboards (all `Asia/Kolkata`, 30 d default range):

| Dashboard | uid | Content |
|---|---|---|
| Business health | `cnote-business` | Phase-1 gate scorecard (latest value vs ADR target), key trends, open metric alerts |
| Trust | `cnote-trust` | lead to conversation, refunds (overall and by category), response time, fan-out, false-badge proxy, credits consumed/refunded |
| Money | `cnote-money` | escrow dispute-refund rate, payout latency, dispute resolution, credit GNPA proxy and attach share, live payout and reconciliation queues |
| Platform | `cnote-platform` | outbox backlog and lag, event throughput, relay delay, DLQ depth, event stream length, metrics job freshness, Sentry links |
| ONDC and ads | `cnote-ondc-ads` | ONDC orders and IGM issues, ad clicks by validity, invalid-click share, impressions served vs lost |

Immature days: a metric of day D keeps changing until D + `windowDays`. The dashboards show recent days for trend; alerts only fire from matured days (the metrics job decides, Grafana alerts on the resulting `metric_alerts` rows).

## 3. Alert rules and routing

Metric alerts are defined once, in `definitions.ts`, and Grafana fires on **open `metric_alerts` rows** (so thresholds and minimum samples are never duplicated).

| Rule | Source | Threshold (ADR) | Route |
|---|---|---|---|
| lead_to_conversation_rate | metric alert | < 60% (002) | product-ops |
| conversation_to_deal_rate | metric alert | < 15% (002) | product-ops |
| auto_refund_rate | metric alert | > 10% (002) | product-ops |
| false_badge_proxy | metric alert | > 0.5% (003) | product-ops |
| median_lead_response_minutes | metric alert | > 120 min SLO (002) | product-ops |
| time_to_first_listing_median_minutes | metric alert | > 15 min (004) | product-ops |
| onboarding_completion_rate | metric alert | < 60% (004) | product-ops |
| escrow_dispute_refund_rate | metric alert | > 0.5% fraud proxy (012) | finance-ops |
| escrow_payout_minutes | metric alert | > 1440 min (012) | finance-ops |
| dispute_resolution_minutes | metric alert | > 10,080 min = 7 d median (013) | finance-ops |
| credit_npa_rate_proxy | metric alert (new) | > 2% (019) | finance-ops |
| credit_attached_order_share | metric alert (new) | < 15% (019) | finance-ops |
| Outbox lag | SQL on `domain_events` | oldest unpublished > 5 min for 5 min | platform-oncall (critical) |
| Metrics job stale | SQL on `metric_daily` | no write for > 1 h | platform-oncall |
| Payout pending too long | SQL on `escrow_payouts` | seller payout pending > 26 h | finance-ops (critical) |
| Reconciliation issue open | SQL | open > 24 h | finance-ops (critical) |
| DLQ not empty | Redis `xlen` | `notification.deliver` dead letters > 0 | platform-oncall |

Routing (`routing.json`): `platform-oncall` (page, repeat 1 h), `finance-ops` (repeat 4 h; payouts and reconciliation are money-in-flight), `product-ops` (ticket/chat, repeat 12 h; default receiver). Contact points are webhooks (PagerDuty/Opsgenie/Slack integration URL supplied by env); pick the target per team. Metric alerts on money metrics are labelled critical because a breach means escrowed funds or lender exposure.

Sentry alerting (configured in Sentry, not here): new-issue alert per app, error-rate spike (> 2x 7-day baseline) to platform-oncall, and any issue tagged `app:worker` with > 10 events in 10 min.

## 4. Metric to ADR map (Phase 2 and 3 additions)

| Metric id | Definition | Why a proxy |
|---|---|---|
| `escrow_dispute_refund_rate` | escrows funded on the day refunded through a dispute decision within 60 d | "fraud rate" needs adjudicated fraud labels; dispute refunds over-estimate |
| `escrow_payout_minutes` | median EscrowReleased to first PayoutSettled | wall-clock, not business days; the 1440 min threshold is a conservative bound |
| `dispute_resolution_minutes` | median DisputeOpened to DisputeResolved | exact |
| `dispute_auto_resolution_rate` | share auto-decided | context, no target |
| `credit_npa_rate_proxy` (new) | loans disbursed on the day with a 90+ DPD overdue event within 180 d, by count | true GNPA is outstanding-weighted |
| `credit_attached_order_share` (new) | escrow-funded orders with a loan disbursed within 30 d, by count | ADR target is GMV-weighted |
| `quote_draft_approval_rate`, `escrows_funded`, `ondc_*`, `credit_*`, `agent_negotiations_closed`, `price_benchmark_runs` | counts and context | no ADR target |

## 5. Runbooks

Common first step for any alert: open the dashboard row, check the sample size (denominator) and whether the day is matured; then follow the section below.

### Runbook: outbox lag
Symptom: `domain_events.published_at IS NULL` backlog or oldest row older than 5 min. Check the worker pods are running and the relay job logs (Sentry `app:worker`); check Redis reachability (`redis-cli ping`, memory, `XLEN cnote:events`). Restart the worker; the relay republishes unpublished rows (safe: handlers are idempotent). In a failover, follow `dr-runbook.md` section on worker start. If the backlog persists with a healthy worker, look for a poison event failing in a handler (DLQ panel) rather than in the relay.

### Runbook: DLQ
Open admin > Queues, inspect the dead-lettered message and its last error, fix the cause (provider outage, bad template, missing consent), then replay. Never replay marketing notifications after consent was withdrawn (the handler re-checks consent).

### Runbook: metrics stale
`metrics.refresh-recent` runs in the worker every 15 min. Confirm the worker is up and the DB replica lag is small; run `pnpm --filter @cnote/metrics backfill -- --from YYYY-MM-DD` to backfill after an outage.

### Runbook: trust metrics
Lead to conversation, conversation to deal, auto-refund, response time. Check volume first (a small cohort is noise; alerts already need a minimum sample). Break down by category on the Trust dashboard; look for one category or seller cohort. Refund spike: inspect reasons (unreachable, fake, rejected enquiry), check OTP/SMS delivery and the intent-scoring hold rate. Response-time breach: check the 2 h cascade job and notification delivery (DLQ). Ranking and lead counts are product decisions, never tuned to hit a target (ADR-002).

### Runbook: seller onboarding
Time to first listing and onboarding completion: check WhatsApp channel health, ASR/extraction queue (`catalogue.transcribe`) and moderation queue age (admin), and the AI provider status.

### Runbook: escrow fraud
Dispute-refund share above 0.5% with at least 50 funded escrows. Review recent disputes by seller and category in admin; check auto-resolution decisions (`decidedBy=auto`) for a bad model or policy change; consider disabling auto-resolution (flag) and freezing payouts for the offending seller cohort (staff action, audited).

### Runbook: payout latency
Pending seller payouts older than one business day or median above the threshold. Check the PA partner status page and webhook delivery (`escrow_webhook_events`), failed payouts with `last_error`, partner cut-off times. Retry failed payouts from admin; escalate to the partner with the `partner_ref`s.

### Runbook: reconciliation
Open `escrow_reconciliation_issues`: ledger versus partner statement mismatch. Finance resolves in admin (each resolution is audited). Do not release or refund related escrows manually until resolved.

### Runbook: dispute SLA
Median resolution above 7 d: check adjudicator queue size and SLA breaches in admin > Disputes, rebalance, and check the AI brief job (`disputes.brief`) for failures.

### Runbook: credit GNPA
Proxy above 2% (by count) with at least 50 disbursals. Pull the outstanding-weighted GNPA from admin > Credit (`computeGnpa`), review by partner and FLDG exposure, pause new disbursals through the credit flag or partner limits if the true GNPA breaches the ADR-019 line, and notify the NBFC partner per contract.

### Runbook: credit attach
Share below 15% is a growth signal, not an incident: check offer coverage, KFS acceptance drop-off and partner approval rate. Route to product-ops.

## 6. What could not be computed from the event log alone

| Target | Gap | Where to read it today |
|---|---|---|
| Credit GNPA < 2% (ADR-019) | events carry `dpd` and `CreditRepaid.outstandingPaise`, but not a per-loan outstanding snapshot at 90 DPD, so an outstanding-weighted ratio needs the loan mirror | `@cnote/credit` `computeGnpa` / `overallGnpa` / `partnerGnpa`, admin > Credit. Count-based proxy `credit_npa_rate_proxy` is alerted |
| Credit-attached GMV >= 15% of escrowed GMV | `CreditDisbursed.amountPaise` is the loan, not the order value; join to `EscrowFunded.amountPaise` per order is possible in SQL but `@cnote/metrics` specs are count-based | `creditAttachedGmvShare` in `@cnote/credit`. Count proxy `credit_attached_order_share` is alerted |
| >= 20% of matched leads convert to escrowed orders (Phase-2 gate) | `EscrowFunded` carries `orderId`, `LeadMatched` carries `matchId`; the match-to-order link is in the enquiry module tables, not in either payload | Order/match join in the enquiry module. To make it an event metric, add `matchId` to `EscrowFunded` (bump the event version) |
| Escrow-order fraud < 0.5% | needs adjudicated fraud labels | proxy: dispute-refund rate |
| Payout < 1 business day | business calendar (weekends, bank holidays) is not in events | `EscrowPayout.latencyMs` in admin; alert uses 24 h wall-clock |
| Fake-lead precision/recall, listing edit rate, dispute resolution quality | need labelled data | quality/eval jobs |
| ONDC, agent negotiation, price benchmark targets | ADR states no numeric targets | counts on the dashboards |

`@cnote/metrics` may depend only on `@cnote/core` and `@cnote/db` (`scripts/check-boundaries.ts` ALLOWED_DEPS). Reading `@cnote/credit` or `@cnote/escrow` from metrics would add edges from an observer package into domain packages that are not part of the allowed graph; that was not done. If exact GNPA or GMV share alerts are wanted, the clean options are (a) a daily job inside `@cnote/credit` (which already owns those functions) that emits a versioned `CreditBookSnapshot` domain event with the ratios, which `@cnote/metrics` then reads as a plain `count`/value metric, or (b) the read-only SQL sanctioned exception, extended to the credit tables by an architecture decision.
