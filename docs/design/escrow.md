# Escrow via an RBI-authorised Payment Aggregator partner (ADR-012)

Package `@cnote/escrow`. Flag `ESCROW_ENABLED` (default off). Phase 2. The partner holds the money; the Platform
orchestrates milestones and keeps the books. Read with ADR-006 (module boundaries), ADR-007 (event log, Order/Ledger),
ADR-010 (India-only, no card data) and ADR-013 (disputes freeze and settle escrow).

## What ships

| Piece | Where |
| --- | --- |
| Double-entry immutable ledger | `src/ledger.ts`, tables `ledger_accounts / ledger_journals / ledger_lines` |
| Escrow agreement + state machine | `src/escrow.ts`, `src/state.ts`, table `escrow_agreements` |
| Fee + GST | `src/fee.ts` |
| PA partner port + adapters | `src/partner/` (`mock`, `razorpay_route`, `cashfree`) |
| Webhook ingress (idempotent) | `src/webhook.ts`, table `escrow_webhook_events` |
| Payouts and refunds | `src/payouts.ts`, table `escrow_payouts` |
| Reconciliation | `src/reconcile.ts`, table `escrow_reconciliation_issues` |
| Metric inputs | `src/stats.ts` |
| Worker (handlers and jobs) | `src/worker.ts` |
| UI | buyer `apps/web/src/features/escrow`, seller `apps/seller/src/features/escrow`, admin `apps/admin/src/app/(console)/escrow` |

## State machine

```
created -> awaiting_funding -> funded -> accepted -> released
                 |               |          \-----> refunded   (refunded also reachable from funded)
                 v               v
             cancelled      (frozen overlay while a dispute is open)
cancelled -> created  (buyer re-opens a lapsed, never-funded escrow)
```

* `created`: row exists, partner collect link not yet issued (retry-safe).
* `awaiting_funding`: partner collect link issued; lapses after `ESCROW_FUNDING_TTL_HOURS` (`cancelled`, `EscrowRefunded` with amount 0, cause `funding_expired`).
* `funded`: the partner webhook confirmed the exact amount. Journalled into `buyer_escrow:<orderId>`.
* `accepted`: transient (buyer accepted or the order completed); the same transaction releases. The auto-release sweep also finishes any that were left here.
* `released` / `refunded`: nothing left held. A split settlement ends `released` when any part went to the seller.
* **Frozen** is an overlay (`escrow_freezes`, one row per dispute), not a status. Any open freeze blocks accept, auto-release and staff release/refund. Only the dispute decision may move frozen money.

Milestones follow the Order through `OrderStatusChanged` (`confirmed`, `dispatched`, `delivered`), plus `funded` and
`accepted`. `completed` (buyer) counts as acceptance. `cancelled` refunds a funded escrow (cause `cancelled`) or closes an
unfunded one. Milestones are unique per escrow, so replays are no-ops. Delivery starts the auto-release clock
(`ESCROW_AUTO_RELEASE_DAYS`, default 7); funding after delivery starts it at funding.

Escrow is optional per deal. `shouldNudgeEscrow(buyerId, sellerId)` is true when the pair has no completed order together
(read through `@cnote/enquiry.listOrders`); the buyer panel shows a strong nudge then.

## Ledger and chart of accounts

Rules: every journal balances, every line has exactly one positive side, journals and lines are append-only (this
package has no update/delete path; corrections are new journals), balances are derived, `postJournal` is idempotent by
`key`. Amounts are integer paise (`BigInt` columns, `Number()` at the boundary).

| Account | Kind | Normal | Meaning |
| --- | --- | --- | --- |
| `partner_nodal` | asset | debit | funds at the partner (escrow + fee + GST not yet swept) |
| `buyer_escrow:<orderId>` | liability | credit | held for the buyer's order |
| `seller_payable:<businessId>` | liability | credit | released, not yet paid out |
| `buyer_refund_payable:<businessId>` | liability | credit | refund decided, not yet paid |
| `platform_fee` | revenue | credit | escrow fee (ex GST) |
| `gst_output` | liability | credit | GST on the fee |

Journals (key -> lines):

* `fund:<escrowId>`: Dr `partner_nodal`, Cr `buyer_escrow`.
* `release:<escrowId>:<releasedSoFar>`: Dr `buyer_escrow` R; Cr `seller_payable` R-fee-gst, Cr `platform_fee` fee, Cr `gst_output` gst.
* `refund:<escrowId>:<refundedSoFar>`: Dr `buyer_escrow`, Cr `buyer_refund_payable`.
* `transfer:<payoutId>` (journal kinds `payout` / `refund_payout`): Dr the payable, Cr `partner_nodal`.

Fee and GST stay in `partner_nodal` until swept to the operating account (sweep journal is an open item).
Journal `kind` values: `fund | release | refund | payout | refund_payout`.

## Fee

`fee = min(cap, round(amount * ESCROW_FEE_BPS / 10000))`, default 150 bps (1.5%), cap `ESCROW_FEE_CAP_PAISE` (Rs 5,000).
GST 18% (`PLATFORM_GST_RATE_BPS`) on the fee. Charged only on escrowed orders, **to the seller, deducted at release**; the
buyer pays exactly the order total and the UI says so. On a split dispute outcome the fee is charged on the released
part only. At release a GST tax invoice for the fee is issued to the seller through billing's `issueInvoiceTx` (SAC from
`platformSupplier()`); if the seller has no billing profile the release still proceeds and no invoice is issued (the fee
and GST are still journalled). Invoice numbering therefore has a gap to close: see open items.

## Partner port

`EscrowPartner` (`src/partner/types.ts`): `createCollect` (virtual account / collect link), `releasePayout`, `refund`
(both idempotent by our payout id), `verifyWebhook(raw, headers)` (null when the signature is bad), `fetchStatement`,
plus `authoritativeStatement` (the mock's statement is a best-effort echo, so "missing at partner" is not flagged for it).
Factory `getEscrowPartner()` from `ESCROW_PARTNER=mock|razorpay_route|cashfree` (default `mock`); an escrow remembers its
partner, so switching env does not strand in-flight escrows.

* `mock`: deterministic, in-process. `simulateCollect` builds the **signed** webhook a real partner would send, and the dev
  checkout button feeds it through `handleEscrowWebhook` (`simulateMockFunding`, refused in production unless `ESCROW_MOCK_CHECKOUT=1`).
* `razorpay_route`, `cashfree`: money calls throw "not configured" without credentials and "not implemented" with them.
  Webhook signature verification and event mapping are real (`ESCROW_WEBHOOK_SECRET`; Razorpay hex HMAC of the body, Cashfree base64 HMAC of timestamp+body).

`handleEscrowWebhook(provider, rawBody, headers)`: verify -> store `(provider,eventId)` once -> apply, all in one
transaction (a failure rolls the event row back so the partner's retry re-applies; a duplicate returns `duplicate`).
Handles `collect.captured` (funding; a wrong amount or a payment for a cancelled/unknown escrow opens a reconciliation
issue instead of funding), `payout.settled`, `payout.failed` (back to the retry queue).

## Payouts and reconciliation

A release/refund decision writes an `EscrowPayout` (`seller_payout` = net of fee and GST, `buyer_refund`). The
`escrow.process-payouts` job submits it to the partner; once settled (immediately or by webhook) the transfer journal is
posted and `PayoutSettled` is emitted with `latencyMs` = settle time minus the release decision (ADR target: under one
business day). Eight failed attempts mark it `failed` and open an issue; a transfer submitted but unconfirmed for 48h opens a `payout_stuck` issue.

`reconcile()` compares partner statement sums per (escrow, kind: collect/payout/refund) with the ledger's `partner_nodal`
movements, and checks the trial balance. Differences become `EscrowReconciliationIssue` rows (`amount_mismatch`,
`missing_in_ledger`, `missing_at_partner`, `balance_mismatch`, plus `funding_amount_mismatch`, `late_funding`,
`payout_failed`, `payout_stuck` from the money paths), de-duplicated by key. Staff review and resolve with a note in the
admin console (`escrow.manage`, audited); nothing there moves money by itself.

## Disputes (ADR-013)

* `DisputeOpened` on an order with an escrow: freeze (`EscrowFrozen`), idempotent per dispute.
* `DisputeResolved`: lift that dispute's freeze (`EscrowUnfrozen`). When no other dispute is open, move funds per
  `refundPaise` / `releasePaise`, clamped to what is held (`EscrowRefunded` / `EscrowReleased`, cause `dispute_resolution`).
  Withdrawn (0/0) just resumes and restarts the auto-release clock. A remainder not covered by the decision stays held.
* Auto-release never fires while frozen: checked in the sweep and again under the row lock.

## Flag behaviour

`ESCROW_ENABLED` off: `createEscrowForOrder`, `acceptDelivery`, `simulateMockFunding` refuse (`forbidden`), panels and the
offer are hidden (the buyer panel is not rendered unless an escrow already exists), views report `actions` false. Worker
handlers and jobs are **not** gated, webhooks are not gated, and staff manual release/refund is not gated: escrows that
already hold money keep moving.

## Environment

`ESCROW_ENABLED`, `ESCROW_PARTNER`, `ESCROW_WEBHOOK_SECRET`, `ESCROW_FEE_BPS` (150), `ESCROW_FEE_CAP_PAISE` (500000),
`ESCROW_AUTO_RELEASE_DAYS` (7), `ESCROW_FUNDING_TTL_HOURS` (72), `ESCROW_MIN_PAISE` (10000), `ESCROW_RECON_GRACE_MINUTES` (30),
`ESCROW_MOCK_CHECKOUT`, `RAZORPAY_KEY_ID/SECRET`, `CASHFREE_CLIENT_ID/SECRET`.

## Metrics hooks

`escrowStats({from,to})`: created, funded (+ paise), released, refunded, disputed, a fraud-rate proxy, payout latency
p50/p95 and share under 24h. `escrowConversionRate(escrowedOrders, matchedLeads)`: matched leads (LeadAccepted count)
come from the event log on the metrics side. Targets: conversion >= 20%, fraud < 0.5%, payout latency < 1 business day.

## Design research (Mobbin)

Adopted patterns, all web:

* Upwork, "Contract details (client)" flow (https://mobbin.com/flows/e362d3c2-551b-4546-9641-b7d9ed31ed19): a milestone timeline
  with a funded state per milestone and a plain-language "Action required ... funds will be automatically released on <date>"
  block. We adopted the timeline, the explicit auto-release date and the single primary action.
* Upwork, "Paying a contract" flow (https://mobbin.com/flows/76c0f49b-d95e-44b7-8135-a276d9945000): review, then approve and pay, then a
  success confirmation. We adopted "review before release" as one confirm action with a sentence on what it does.
* Fiverr, "Creating a milestone offer" (https://mobbin.com/flows/6d782914-34fb-4755-a1be-72250eb86078): milestones as a short ordered list. Adopted for list structure only (we do not split one order into several milestones in v1).
* Walmart order details (https://mobbin.com/screens/c75ab520-4707-4e7b-9d65-7e5d7c888111) and adidas order progress
  (https://mobbin.com/screens/fcff9285-bb90-4bee-aae9-547cbcf6b26d): stepper of order stages with the current one emphasised.
  We used an ordered list with "Done, <date>" / "Pending" in text so status is never colour alone (WCAG 2.2 AA).

## Open items

* Legal and partner contract: which PA partner and product (Route vs Cashfree Escrow vs a bank nodal), settlement SLAs, virtual-account structure, KYC hand-off, and confirmation that seller-borne fee plus GST on the fee is the right tax treatment.
* Real adapters: payment collection, transfers and statement calls are unimplemented until sandbox credentials exist.
* Fee sweep from `partner_nodal` to the operating account, with its own journal and reconciliation line.
* Fee invoice gap: release proceeds without an invoice when the seller has no billing profile; a follow-up should re-issue later so GST is not left uninvoiced. Billing's invoice numbering is gapless per transaction, so no numbers are burned.
* Fraud rate is a proxy (disputed and refunded / funded) until ADR-013 fault data is wired.
* Partial-release milestones (several payments per order) are out of scope for v1.
* DB-level append-only enforcement (trigger) for ledger tables would need hand-written SQL that `db:new` strips; today it is enforced by having no mutation path.
* Order rows still say `settlement = "off_platform"`; enquiry owns that column and should flip it to `escrow` on `EscrowFunded`.

## Per-business reads (ADR-019 underwriting)

`src/reads.ts`, read-only (no change to escrow behaviour):

* `escrowHistoryForBusiness(businessId, { role? })` returns `{ completed, completedPaise, clean, refunded }` from SQL aggregates over every escrow of the business
  (completed = released; clean = released with no `EscrowFreeze` ever; refunded = ended refunded). No page limit or sampling.
* `listEscrowsForBusiness(businessId, { role, status, cursor, limit })` is keyset-paged newest first (`createdAt`, `id` tie-break, opaque cursor) and returns
  `{ items, nextCursor }` (limit 1..200, default 50).

`@cnote/credit`'s default ports use them (the 200-row sampling approximation is gone).
