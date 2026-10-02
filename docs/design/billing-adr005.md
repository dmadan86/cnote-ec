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

## Cancellation and refund

- Refund = floor(amount actually paid, GST included, x unused full months / 12). The first month always counts as used (its credits are granted up front) and a started month is not refunded. Capped to what remains refundable. Monthly plans refund nothing.
- The refund goes through the payment provider port (`refundPayment`: mock, Razorpay, Cashfree all implement it) with a credit note. It runs after the cancellation commits; a provider failure is logged and leaves a failed `PaymentRefund` row for finance, the cancellation stands.
- `SubscriptionCancelled` is version 2: adds `billingInterval`, `refundPaise`, `unusedMonths`, `effectiveAt`, `reason`. It is emitted in the same transaction as the state change. Cancelling twice, or concurrently, is rejected with `not_found` after the first (business advisory lock), so there is one event and one refund.
- The paid plan ends immediately and the business moves to Free until the original period end (capped at 30 days, then the lapse job re-grants Free credits). Credits already held stay spendable until their own expiry.

## Cancel in 3 taps (seller app)

1. Billing: "Cancel plan" (link to `/billing/cancel`).
2. Confirm screen, computed by `previewCancellation` (the same code the cancellation runs): end date, refund amount and unused months (or "no refund" and why), credits kept with each lot's expiry, "nothing renews automatically". One optional reason select (nothing preselected), one "Yes, cancel my plan" button, one "Keep my plan" link.
3. Redirect to Billing with "Your plan is cancelled" and the refund line. That is 2 activations; the e2e asserts at most 3.

## Pricing calculator

- Pure functions in `packages/billing/src/pricing.ts`, exported as `@cnote/billing/pricing` (no server imports, safe in client bundles): `calculatePricing`, `planPeriodPricePaise`, `gstOnPaise`, `recommendPlan`, `annualRefundPaise`, `usedMonths`. GST rounding is identical to `splitGst` (property-tested).
- Inputs: leads per month, plan, monthly or annual. Output (polite live region): GST-inclusive price, ex-GST and GST parts, effective monthly price and saving for annual, cost per lead (monthly equivalent / covered leads), spare credits, shortfall, and when credits expire (90 days from each monthly grant).
- Public `/pricing` stays static (ISR); the calculator is a client island that receives only its own `pricing2` message namespace. The seller Billing page embeds the same form with `billingAnnual` messages.

## Open questions

- Monthly cancel ends the paid plan now with no refund; an alternative is keeping access until the period end (needs a cancel-at-period-end state).
- Non-English catalogues are machine drafted and marked `_meta.review` for native review.
