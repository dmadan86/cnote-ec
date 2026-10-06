# Payments and GST invoicing

Implements ADR-001/005 (transparent pricing, no auto-renew) and ADR-010 (no card data). Code: `packages/billing/src/{payments,payment-providers,invoices,parties}.ts`.

## Flow

1. `startCheckout(actor, {purpose, planCode|packId, couponCode?})` computes list price (ex-GST), optional coupon discount (before GST), GST at `PLATFORM_GST_RATE_BPS` (default 18%), and creates a `PaymentOrder` + the provider's **hosted** checkout. The seller is redirected; we never see card/UPI data.
2. The provider calls `POST /webhooks/payments/{razorpay|cashfree}` (apps/api). The raw body is verified (HMAC), logged in `PaymentWebhookEvent` (unique `provider+eventId`, payer identifiers redacted), and processed.
3. `fulfilOrder` runs in one transaction under a row lock on the `PaymentOrder` and sets `fulfilledAt`: subscription activation or credit grant, coupon bonus credits, tax invoice, `PaymentSucceeded`. Repeats and concurrent deliveries are no-ops. The amount reported by the provider must equal `totalPaise`, else the order is failed (`amount_mismatch`) and nothing is granted.
4. The return page (`/billing/return`) also reconciles by asking the provider once (`fetchPayment`) if the webhook is late.
5. `refundPayment` reserves the amount under the order lock, calls the provider, then issues a credit note and emits `PaymentRefunded`. Annual-plan cancellation refunds the pro-rata share of the tax-inclusive amount actually paid (`refundForCancellation`).
6. Dev: `PAYMENTS_PROVIDER=mock` shows a local pay page that signs a mock webhook and pushes it through the same path. The mock provider is refused in production.

## Providers (plain `fetch`, no SDK)

**Refund confirmation polling (ai_ops).** A refund the provider accepted stays `pending` until a webhook confirms it, so a lost webhook would leave it "initiated" forever. The `billing.refund-poll` job (every 10 min) asks the provider (`PaymentProvider.fetchRefund`: Razorpay `GET /v1/refunds/{id}`, Cashfree `GET /pg/orders/{order_id}/refunds/{refund_id}`, mock via `PAYMENTS_MOCK_REFUND_STATUS`) about refunds still pending after `REFUND_POLL_AFTER_MINUTES` (30), with exponential backoff (30 min doubling, cap 12 h, at most `REFUND_POLL_MAX` = 8 polls, then an alert). Outcomes go through the same `settleRefund` compare-and-set as the webhook, so whichever arrives first wins and the other is a no-op (one `RefundCompleted`, one dead letter). A provider error only logs and backs off. Columns `poll_attempts`, `next_poll_at`, `last_polled_at` on `payment_refunds`.

- **Razorpay**: Payment Links (`POST /v1/payment_links`, `reference_id` = our order id, amount in paise, `callback_url`) give a hosted page. Webhook signature = hex HMAC-SHA256 of the raw body with the webhook secret in `X-Razorpay-Signature`; `x-razorpay-event-id` is unique per event (our idempotency key). We act on `payment_link.paid` (success) and `payment_link.expired|cancelled` (failure); a single `payment.failed` does not end a link because the payer can retry. Refund: `POST /v1/payments/{id}/refund`.
- **Cashfree**: `POST /pg/orders` (`order_id` = our id, amount in rupees, `customer_phone` required, `order_meta.return_url/notify_url`), `payment_session_id` opens the hosted checkout. Webhook signature = base64 HMAC-SHA256 of `x-webhook-timestamp + rawBody` with the PG secret key in `x-webhook-signature`. Events `PAYMENT_SUCCESS_WEBHOOK` / `PAYMENT_FAILED_WEBHOOK`; no event id is provided so we derive `type:cf_payment_id:event_time`. Refund: `POST /pg/orders/{order_id}/refunds`.
- The hosted-checkout URL prefix for Cashfree is `CASHFREE_CHECKOUT_BASE` (default `https://payments.cashfree.com/order/#`); confirm against the merchant dashboard before go-live.

## GST (Rule 46 CGST Rules, 2017)

- Mandatory fields rendered: supplier name, address, GSTIN; consecutive serial number unique per FY, max 16 characters (we use `CN/26-27/000123`, 15 chars; credit notes `CR/26-27/000123`); date; recipient name, address, GSTIN if registered; SAC (default 998314, configurable `PLATFORM_SAC`); taxable value; CGST/SGST or IGST with rates; place of supply (state code); total in figures and words; "computer generated" note.
- Numbering is gapless: `INSERT ... ON CONFLICT DO UPDATE` on `InvoiceSequence` takes a row lock held until the issuing transaction ends, so a rollback returns the number. Series and FY (April to March) are computed in IST.
- Place of supply: recipient state (from GSTIN prefix, else registered address state code), else the supplier's state. Same state as `PLATFORM_STATE_CODE` gives CGST+SGST (CGST = floor(GST/2), SGST = remainder so the split sums exactly), otherwise IGST. GST rounds half-up to the paisa.
- Refunds produce credit notes (section 34 CGST Act) referencing the original invoice, priced from the tax-inclusive refund so taxable + GST equals the refund exactly.
- Open items for a CA before launch: SAC/rate per service line (lead credits vs subscription vs ads), time of supply for advances, e-invoicing applicability by turnover (IRN/QR), TCS/TDS by payment aggregators, whether the 16-character limit is to be met with the `CN/26-27/` form.

Sources: Razorpay webhook validation https://razorpay.com/docs/webhooks/validate-test/ ; Razorpay Payment Links create https://razorpay.com/docs/api/payments/payment-links/create-standard/ ; Cashfree webhooks https://www.cashfree.com/docs/payments/online/webhooks/overview ; Cashfree create order https://www.cashfree.com/docs/api-reference/payments/latest/orders/create ; CGST Rules 2017 Rule 46 (tax invoice) and section 34 (credit notes), https://cbic-gst.gov.in .

## Mobbin references (patterns adapted to `@cnote/ui`, no branding copied)

- Order summary before payment (Price, discount, taxes, "Due today", "Continue to payment"): [Obvious upgrade flow](https://mobbin.com/flows/a00a3d50-c2ac-42a2-bce1-e9fac6f984f5), [Laravel Cloud subscribe flow](https://mobbin.com/flows/ec461f93-c1cf-4f04-bf16-31751e1c9749) (discount code with Apply beside a summary), [GoDaddy cart](https://mobbin.com/flows/75d9d876-748e-40dd-9672-a2afe116e8c1). Adopted as `/billing/checkout`: a summary card with the GST split (CGST+SGST or IGST) and a discount code field; a bad coupon warns but never blocks the purchase.
- Invoices list with a status pill and one-tap download: [fal invoices](https://mobbin.com/screens/d13091a5-c08e-4f4a-a9fa-d6783b9ccbb2), [Magnific billing history](https://mobbin.com/screens/bef956a7-c7b0-41e5-9b0f-1d3dea4a6d07). Adopted as the "Tax invoices" card (number, date, Paid/Refunded badge, amount, "Invoice PDF").
- Plan, credits and history on one billing page: [Obvious billing](https://mobbin.com/flows/a00a3d50-c2ac-42a2-bce1-e9fac6f984f5). Kept the existing layout and added a "Buy lead credits" row of packs.
- Payment confirmation with receipt and next action: [Cofounder payment confirmed](https://mobbin.com/screens/05f69298-db76-4ede-9997-73e1764f4c16), [HoneyBook receipt](https://mobbin.com/screens/b99951d1-8d5d-4f6b-a0ac-bfb83cc60217), [Flodesk thanks page](https://mobbin.com/screens/88dc837d-3f2e-4e19-851f-2dfadf00390f). Adopted as `/billing/return`: status alert, total, primary "Download tax invoice" and secondary "Back to billing"; auto-refreshes while pending.
- Deliberately not adopted: on-page card forms (ours redirects to the gateway, ADR-010).

## Known gaps

- Coupon linkage is packed into `PaymentOrder.purposeRef` (`ref|couponId|creditsBonus`); dedicated `coupon_id` / `credits_bonus` columns would be cleaner (needs a migration).
- Invoice PDFs render on demand; the private-media cache is optional via `setInvoiceDocStore` and needs an `invoices/` key prefix and `pdf` mime in `@cnote/media`.
- Refunding a credit pack does not claw back unspent credits (policy decision pending).
