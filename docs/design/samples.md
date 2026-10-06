# Sample request and approval workflow

Per ADR-002 (limited, transparent matching; contact revealed after the seller commits), ADR-003 (real verification tiers, trust is earned), ADR-007 (lifecycle modelled now, events versioned), ADR-008 (no model sees photos), ADR-010 (DPDP: ship-to and photos are personal data), WCAG 2.2 AA on the buyer web. Module: `@cnote/samples`. Flag: `SAMPLES_ENABLED` (default off).

A buyer who is about to place a bulk order asks the supplier for a sample, evaluates it, and if it passes, raises the bulk request with the approved sample attached as the quality reference (the "golden sample"). Sample payment is **off-platform in Phase 1**: we record the amount and whether it is adjustable against the bulk order; no money moves.

## Mobbin research (cited)

- Request form with address details: [DoorDash Merchant, Request a delivery](https://mobbin.com/screens/a2bc3187-ce9e-4dda-af7d-eefa6dd509f2) (customer details, delivery address, optional fields marked "(Optional)") and [Etsy, Create shipping option](https://mobbin.com/screens/3c3ccd8f-70dd-4afe-ab97-10ba50da840e) (label with side help text, required marker). Adopted: one grouped "Where should we send it?" fieldset, every optional field labelled "(optional)", help text under the control, not in a placeholder.
- Modal form: [Shopify, Add shipping option](https://mobbin.com/screens/56a5947f-1bd4-4c70-acc9-a6b555634d08) and [Square, Create custom unit](https://mobbin.com/screens/ba8b875d-43e7-4439-9a4c-14fb1e9d4a06). Adopted: a modal with a title and a close control on the product page; implemented with the native `<dialog>` so focus trapping and Esc come from the platform.
- Order tracking timeline: [H&M, order status](https://mobbin.com/screens/937562b2-1901-483a-96f4-653b7d340aad) (numbered steps Received / Processed / Shipped / Delivered), [ZARA, order detail](https://mobbin.com/screens/431e59ae-6bbe-4e37-8dac-456a55cb3b3e) (horizontal stepper with dates) and [Shopify, order timeline](https://mobbin.com/screens/c736e731-09a6-4e42-9c38-0b184e9bd018) (dated history of every move). Adopted: the same pattern as the order tracking timeline: an ordered list of five steps whose done / now / next state is written out (never colour alone, `aria-current="step"`), plus a dated history list.
- Review with structured criteria and photos: [Zillow, Write a Review](https://mobbin.com/screens/51a493ad-ca02-43c3-8e97-e83de238bea5) (required marker, per-criterion answers before free text) and [GetYourGuide, review photos](https://mobbin.com/screens/dfca6435-5e91-463d-9ee9-e8fe43818ca2) (photo strip under the verdict). Adopted: verdict first, then structured reasons, then optional notes and up to 5 photos; photos shown as a strip with alt text on the detail page, the golden sample card and the seller's page.

## Lifecycle

```
requested --accept--> accepted --dispatch--> dispatched --delivered--> delivered --approve--> approved
    |  \--decline--> declined        \--cancel--> cancelled                      \--reject--> rejected
    |  \--cancel---> cancelled
    \--48h without an answer--> expired
```

`requested`, `accepted`, `dispatched`, `delivered` are **open**; everything else is **final**. The state machine is a pure table (`state.ts`), every transition runs under a row lock (`SELECT ... FOR UPDATE` on the request) and re-checks the status, so concurrent clicks cannot double-apply. Each move appends a row to `sample_status_log` (drives the timeline) and emits a versioned domain event in the same transaction.

| Step | Who | Notes |
|---|---|---|
| request | buyer | from a product page (listing offers samples) or from a matched conversation / quote |
| accept | seller | sets the amount (default: the listing's sample price) and "adjustable against bulk"; reveals the ship-to address |
| decline | seller | structured reason (out of stock, not offered, buyer tier, region, quantity, other) + optional note |
| dispatch | seller | courier (required) + tracking reference; "expected dispatch by" comes from the listing's dispatch days |
| delivered | buyer (normal) or seller | |
| evaluate | buyer | approve, or reject with at least one structured reason; optional notes and up to 5 photos |
| bulk | buyer | "Request bulk quote" (pre-filled RFQ) or "Accept the supplier's quote" when the sample was requested against a quote |
| cancel | buyer | while `requested` or `accepted` |

## Listing-level settings (owned by catalogue)

`Listing` already had `sampleAvailable` and `samplePricePaise`. Added (migration `samples_workflow`): `sampleMaxQty`, `sampleDispatchDays`, `sampleMinBuyerTier`. They live in `TradeInfo`, so they are versioned in the listing snapshot (diffed in the history UI) and projected to the live DB as part of `trade`; `@cnote/samples` reads them through `getPublicListing()`, never through tables. A tier of 0 is not stored. Settings are only kept when `sampleAvailable` is true.

- Seller form: three fields under "Sample available" (seller messages `samples.settings.*`, 8 locales).
- Bulk: columns `sample_available` (yes/no), `sample_price_rupees` (0 = free), `sample_max_qty`, `sample_dispatch_days`, `sample_min_buyer_tier`, placed after `image_urls` so older templates keep working. Blank cells leave the current value unchanged on update (the existing trade facts are merged, not replaced). Export writes the same columns, so a download re-imports unchanged.

## Seller SLA and trust signal

- `respondBy = createdAt + SAMPLES_RESPONSE_HOURS` (48h). The worker job `samples.expire-overdue` (every 15 minutes) expires unanswered requests (idempotent, row-locked, emits `SampleExpired`). A late accept is refused (`samples.expired`) even before the sweep runs; the UI shows "past the deadline".
- **Trust read model, via events only.** `SampleEvaluated` and `SampleExpired` are consumed by identity's trust worker (Redis counters, deduped by event id, like the lead signals). `computeTrustScore` gets two optional inputs: the approval rate is worth at most +-5 points and counts **only from 5 evaluated samples** (60% approval is neutral; each 5 points of rate = 1 point); each unanswered request costs 1 point, capped at 5. Defaults leave existing scores unchanged. Nothing in ranking reads sample data directly; ranking stays relevance x trust (never paid tier).
- **Public approval rate** (`getSellerSampleStats`, from the request table) is shown on the product page and in the seller inbox **only from 5 evaluated samples** (`SAMPLES_MIN_EVALUATED_FOR_RATE`); below that the seller sees "n evaluated so far". Exposed in the API at `GET /v1/sellers/{id}/sample-stats`.

## Abuse guards

Per person: `SAMPLES_REQUESTS_PER_DAY` (10/24h, Redis fixed window). Per buyer business: `SAMPLES_MAX_OPEN_PER_BUYER` (5 open requests). Per product or conversation: one open request (unique `active_key` on the request, cleared on any final status, so a race cannot create two). Quantity: the listing's `sampleMaxQty`, else `SAMPLES_DEFAULT_MAX_QTY` (20). Sellers can require a verified buyer tier per listing (`sampleMinBuyerTier`, real ADR-003 tiers; the buyer's tier is snapshotted on the request). You cannot request a sample of your own product. Declined / expired / cancelled requests free the slot.

## From an approved sample to the bulk order

- **RFQ route.** "Request bulk quote" opens `/rfq/new?sample=<id>`. `getBulkPrefill()` returns the title, category, unit, supplier (as preferred seller), listing, and a requirement note ("Quality reference: the sample I approved on <date> (sample <id8>). Bulk supply must match it."). The RFQ form carries a hidden `sampleId`; after `createEnquiry` succeeds, `linkBulkEnquiry()` stores `bulkEnquiryId` on the sample and emits `SampleBulkQuoteRequested` (the seller is notified). A failure to link never loses the posted requirement.
- **Quote route.** A sample requested against a quote offers "Accept the supplier's quote": `acceptLinkedQuote()` calls the enquiry module's `decideQuote(accept)` (records the deal, creates the order, ADR-007) and marks the bulk request.
- **Golden sample on later pages.** `getGoldenSampleForOrder(actor, orderId)` finds the approved sample between the same two businesses that matches the order's quote, the RFQ raised from the sample, or the requirement the sample was requested in. Both parties see the card (subject, approval date, notes, photos) on their order/PO page: buyer `/buyer/orders/[id]`, seller `/orders/[id]`.

## Screens

Buyer web (all dynamic, under `/buyer`; the public product page stays static): product page "Request a sample" block (offer lines, approval rate, native-dialog form), `/buyer/samples` (filter links with `aria-current`, needs-action badge), `/buyer/samples/[id]` (progress, details, payment record, dispatch, evaluation form, verdict with photos, bulk follow-up), `/buyer/samples/new` (full-page form: the sign-in return target of the dialog and the entry from a conversation/quote). Evaluation with photos posts to `POST /api/samples` (`readBoundedFormData`, excluded from the proxy matcher like `/api/rfq` and `/api/disputes`); photos are served by authorised routes only (`Cache-Control: private, no-store`). Strings: `apps/web/messages/<locale>.samples.json` (8 locales) plus `errors.samples.*`.

Seller app: `/samples` inbox (record card, filters), `/samples/[id]` (accept with price + adjustable, decline with reason, dispatch, mark delivered, record payment received, verdict and photos), nav item. Strings: `apps/seller/messages/<locale>.samples.json` (8 locales).

## Events (all version 1, `packages/core/src/events/catalog.ts`)

`SampleRequested`, `SampleAccepted`, `SampleDeclined`, `SampleDispatched`, `SampleDelivered`, `SampleEvaluated`, `SampleExpired`, `SampleCancelled`, `SampleBulkQuoteRequested`. Every payload carries `buyerBusinessId` and `sellerBusinessId`, so observers (notifications, trust) need no lookup into this module.

## Notifications

`packages/notifications/src/kinds-samples.ts`: 12 kinds, all transactional (category `leads`), English plus a Hindi seed (other locales fall back to English until staff edit the live template). Copy never names contact details; sender-controlled text (business name, courier) is stripped of control characters before it reaches a subject.

## Public API

Scopes `samples:read` / `samples:write` (business-bound). Endpoints under tag **Samples**: `POST/GET /v1/samples`, `GET /v1/samples/{id}`, `POST .../cancel|accept|decline|dispatch|delivered|payment|evaluate|accept-quote|bulk-enquiry`, `GET .../bulk-prefill`, `GET /v1/sellers/{id}/sample-stats`. All answer 404 while the flag is off. `docs/api/openapi.json` is regenerated. Evaluation photos are web-only (multipart upload stays in one place).

## DPDP (ADR-010)

- **Export**: `exportPersonalData` registered in `@cnote/compliance`. The buyer's export contains the ship-to and notes; a seller-side export of the same row has the ship-to and buyer note **blanked** (the seller already saw the address once at accept; the export is about the exporter's own data).
- **Retention**: policy `samples.closed_request_personal_data` (env `RETENTION_SAMPLE_PERSONAL_DATA_DAYS`, default 365 days after a request reached a final status): deletes photos from the private bucket and blanks ship-to, notes and payment/decline notes. Statuses, reasons, amounts and timestamps stay (trust record, audit).
- **Erasure**: on `DataErasureRequested` the person's requests are scrubbed immediately, whatever their status.
- Ship-to is shown to the seller only after accept (ADR-002 spirit). Photos live in the PRIVATE bucket under `samples/<id>/` (key prefix added to `PRIVATE_ONLY`); type is decided from magic bytes, never the declared MIME; they are never sent to a model.

## Decisions

1. **Owned module, no cross-table reads.** `@cnote/samples` owns three tables (`sample_requests`, `sample_media`, `sample_status_log`) with plain-id references; it reaches catalogue (`getPublicListing`), enquiry (`getConversation`, `getBuyerEnquiry`, `getOrder`, `decideQuote`) and identity (`getTrustProfiles`) through public functions.
2. **Payment is a record, not a flow.** Amount, "adjustable against bulk", a note and a "received" timestamp. When Phase-2 escrow can carry small amounts this becomes an order; the fields stay valid.
3. **Address is collected per request**, not taken from the saved address book, because samples often go to a plant or lab rather than the registered office; the buyer can type it once and the dialog works for signed-out visitors (the action signs them in first).
4. **Seller identity of the setting is per listing**, including the minimum buyer tier. A business-wide default is a natural follow-up but would need a seller settings table; per listing needs none.
5. **Public product pages stay static.** The request dialog is a client island on the ISR page; whether it shows follows the flag at regeneration time. Everything stateful lives under `/buyer`.
6. **Trust weight is deliberately small** (+-5, only from 5 evaluated samples) so a few early verdicts cannot move a seller and sample approval can never outweigh verification tier or dispute outcomes.
7. **Evaluation by the buyer only.** A seller cannot evaluate; a seller may mark delivered (courier-confirmed) so a buyer who forgets does not block the flow, but the verdict stays with the buyer. There is no auto-evaluation: an undecided delivered sample simply stays open (it still counts against the buyer's open limit, which is the nudge).
8. **API errors use stable keys** (`samples.*`) with translations in both apps' `errors` namespace.

## Not done (and why)

- No sample-specific dispute path: a rejected sample with a supplier disagreeing goes through the existing conversation; ADR-013 disputes need an order and escrow.
- No auto-reminder for a delivered but unevaluated sample (a follow-up would add a notification job).
- No admin back-office screen for samples (support can read through the DB-backed API with staff tooling later); no metric yet in `@cnote/metrics`.
- MCP tools for samples (REST only), and the WhatsApp channel does not surface sample requests yet.
- Machine-drafted copy: Hindi is team-written; kn/ta/te/mr/gu/bn strings are first drafts and should be reviewed by native speakers.
