# Seller billing per ADR-005: annual plans, 3-tap cancel, pricing calculator

Principles (ADR-005): public self-serve pricing, no auto-upgrade, no auto-renew without confirmation, credits roll over 90 days, cancel in 3 taps.

## Design research (Mobbin)

- Claude web, "Canceling a subscription" (https://mobbin.com/flows/06c91061-5271-4975-8877-b0af0bca4a0a): a dedicated Cancellation card on Billing, one confirm dialog that states the consequence (end date), then a status line with the end date. Adopted: Billing shows a plain "Cancel plan" link; the confirm screen states the consequences; the result is shown on Billing. Not adopted: the modal (a page is easier to keep accessible and gives room for the refund and credit lines).
- Copilot Money, "Cancelling a subscription" (https://mobbin.com/flows/ccda0d21-d216-4455-90e5-f5f3feddcad6): a low-emphasis red text action inside the subscription pane. Adopted: cancel is a visible, ordinary action, never hidden.
- Superhuman Mail (https://mobbin.com/flows/733e8bf4-2ece-4abc-91c7-99885d32bae0): cancellation by email with a "what could we have done" question. Adopted only as the optional reason select (no free-text, not required, no extra step). Not adopted: the retention reply.
- Pricing sections with a monthly/annual switch and a "save N%" tag (Webflow https://mobbin.com/sites/sections/9420ada1-5228-48b0-9ba1-7455d80f0e66, Maze https://mobbin.com/sites/sections/b6220462-e7a4-421c-bda8-748b65ea8f65): adopted the "Annual (save N%)" label, using radios inside a fieldset rather than a switch so the choice is a real labelled group for keyboard and screen readers. Plan cards show the annual price as a second line, never as the default.

## Annual plans

- `Plan.annualDiscountBps` (default 2000, seeded from `BILLING_ANNUAL_DISCOUNT_BPS`, editable per plan). Annual ex-GST price = floor(12 x monthly x (10000 - bps) / 10000). GST 18% is added at checkout and invoiced as a normal tax invoice for 12 months (`purposeRef` = `<plan>:annual`).
- A subscription records `billingInterval`, `paymentOrderId`, `nextGrantAt`, `renewalRemindedAt` (migration `billing_annual_plans`). Credits are granted one month at a time by the `billing.annual-credits` job, so each grant keeps its own 90-day rollover.
- Auto-renew is never on. `billing.renewal-reminders` emits `SubscriptionRenewalDue` 3 days (monthly) or 14 days (annual) before the end; notifications sends the `billing.renewal_due` template, which asks the owner to confirm and says nothing is charged otherwise. Buying the same plan again is allowed in that window (explicit renewal) or to switch interval.

## Cancellation, access and refund

- Cancelling schedules the end (`cancelAtPeriodEnd`): the plan stays active, Billing shows "Ends on <date>", nothing renews. Monthly: access to the paid period end, no refund. Annual: the unused full months are refunded now and access runs to the end of the month counted as used (the period is shortened to that date, no more monthly grants).
- Refund = floor(amount actually paid, GST included, x unused full months / 12). The first month always counts as used (its credits are granted up front). Capped to what remains refundable.
- "Undo cancellation" is one tap before the end date, only while nothing was refunded and the period was not shortened; otherwise the owner buys the plan again.
- The `billing.end-subscriptions` job ends the plan at its end date, emits `SubscriptionCancelled` (v2: `effectiveAt` is now the actual end date, `refundPaise` what was requested at cancel time; same shape, no bump) and starts Free.
- Credits already held stay spendable until their own expiry. Cancelling twice or concurrently is rejected with `conflict`, so the refund is requested once.

## Refund honesty, retry and dead letter

- A cancellation refund goes through `refundPayment(..., { retry: true })`. Row states: `pending` (providerRefundId set = the provider accepted it; null = reserved), `processed` (confirmed by the provider response or a refund webhook), `retrying`, `dead`, `failed` (staff refund that errored; surfaced to the staff member).
- `billing.refund-retry` (every 5 min): a compare-and-set lease claims a due row, the provider is called with the row id as idempotency key (Razorpay `X-Refund-Idempotency`, Cashfree `x-idempotency-key` plus its unique refund_id), backoff 10 min doubling to a 12 h cap, 6 attempts, then `dead`: `RefundDeadLettered` event (metric `refund_dead_letters`) and a loud `ALERT` log for ops.
- Seller-facing status on Billing: "Refund of X initiated" only once the provider accepted it; "Refund of X is processing; we'll retry automatically" while reserved or retrying; "Refunded X" when confirmed; "needs attention; our team has been alerted" when dead. `RefundCompleted` triggers the `billing.refund_completed` notification template. Razorpay `refund.processed/failed` and Cashfree `REFUND_STATUS_WEBHOOK` confirm or fail a pending refund.

## Mock gateway in production builds

`PAYMENTS_ALLOW_MOCK_IN_PRODUCTION=1` is for the e2e servers only (default off, documented in `.env.example`). `mockAllowed()` honours it only when `PAYMENTS_PROVIDER` is `mock` and logs a warning; with razorpay or cashfree configured it is ignored with an error log.

## Pricing calculator

- Pure functions in `packages/billing/src/pricing.ts`, exported as `@cnote/billing/pricing` (no server imports, safe in client bundles): `calculatePricing`, `planPeriodPricePaise`, `gstOnPaise`, `recommendPlan`, `annualRefundPaise`, `usedMonths`. GST rounding is identical to `splitGst` (property-tested).
- Inputs: leads per month, plan, monthly or annual. Output (polite live region): GST-inclusive price, ex-GST and GST parts, effective monthly price and saving for annual, cost per lead (monthly equivalent / covered leads), spare credits, shortfall, and when credits expire (90 days from each monthly grant).
- Public `/pricing` stays static (ISR); the calculator is a client island that receives only its own `pricing2` message namespace. The seller Billing page embeds the same form with `billingAnnual` messages.

## Open questions

- Undo is not offered after an annual refund was started (it would need a re-charge).
- Refund confirmation relies on the provider response and the refund webhooks; there is no polling of provider refund status.
- Non-English catalogues are machine drafted and marked `_meta.review` for native review.
