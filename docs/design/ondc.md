# ONDC seller-network-participant adapter (ADR-017)

Status: built and **live-ready (ADR-021), not yet certified or live**. Flag `ONDC_ENABLED` defaults to `false`; with it off the API routes return 404, nothing is published, and every worker consumer/job is a no-op. Going live needs the ONDC certification items below and ADR-013 dispute capacity (`DISPUTES_ENABLED`).

Package `@cnote/ondc` (`packages/ondc`), schema `packages/db/prisma/schema/ondc.prisma`, routes `apps/api/src/routes/ondc`, seller UI `apps/seller/src/app/(portal)/ondc`, admin UI `apps/admin/src/app/(console)/ondc`.

## Scope

Seller-side only (BPP): we expose opted-in catalogue and receive orders. The buyer experience stays first-party (ADR-017). IGM (issues and grievances) is implemented (ADR-021, below). Out of scope: buyer-side participation (evaluated after two quarters), payments settlement on the network, logistics (ONDC LSP) fulfilment.

## Protocol flows

Buyer app (BAP) calls us at `{ONDC_SUBSCRIBER_URL}/ondc/{action}`; we ACK/NACK synchronously and send the signed `on_*` callback to `context.bap_uri/{on_action}` from a queue.

```
BAP -> POST /ondc/search   -> verify -> store -> ACK
                              worker: ondc.inbound -> catalogue filter -> ondc.callback -> POST bap_uri/on_search
select   -> on_select   quote from catalogue prices (MOQ enforced; buyer-supplied prices ignored)
init     -> on_init     quote + payment { POST-FULFILLMENT, collected_by BPP, NOT-PAID } (Phase 1: settlement off-network)
confirm  -> on_confirm  OndcOrder created (idempotent), OndcOrderReceived emitted, order sink called
status   -> on_status   order state mirror
cancel   -> on_cancel   allowed from created/accepted
seller accept/reject in the seller portal -> unsolicited on_status / on_cancel (fresh message_id)
```

Inbound processing order in `receiveInbound`: flag -> size -> JSON -> envelope (`context` + `message`, `context.action` must equal the path) -> signature (signer must equal `context.bap_id`, key active in registry) -> domain/city policy -> `bpp_id` equals us (except search) -> per-action message shape -> idempotent store keyed `(direction, action, transaction_id, message_id)` -> enqueue -> ACK. Duplicate deliveries are ACKed without a second job; a redelivery of a `failed` row re-queues it.

Responses: ACK `{"message":{"ack":{"status":"ACK"}}}`; NACK adds `error {type, code, message}` (10000 schema, 10001 signature, 10002 domain/city, 10003 not our bpp_id, 20000 unavailable). HTTP 401 for signature failures, 400 for malformed, 503 (retryable) for registry/queue outages.

### Context

`domain` (from `ONDC_DOMAINS`, default `ONDC:RET10`; **confirm the B2B domain code assigned to us during ONDC onboarding**), `country` IND, `city` (`ONDC_CITY_CODES`, `*` = all), `core_version` 1.2.0, `bap_id/bap_uri`, `bpp_id/bpp_uri` (us), `transaction_id`, `message_id`, `timestamp`, `ttl`. Callback context = inbound context with `action=on_x`, our bpp identity, fresh timestamp; same `message_id` for solicited callbacks.

### Error codes

Domain errors we emit: 30001 provider unavailable, 30004 item/order not found, 40002 below MOQ, 45003 cannot cancel in this state. These are our best mapping and **must be reconciled against the ONDC error-code sheet during certification**.

## Signing (ONDC auth spec)

- Digest: `base64(BLAKE2b-512(body))` (Node `blake2b512`).
- Signing string: `(created): {unix}\n(expires): {unix}\ndigest: BLAKE-512={digest}`.
- Signature: `base64(ed25519(signing string))`.
- Header: `Signature keyId="{subscriber_id}|{unique_key_id}|ed25519",algorithm="ed25519",created="…",expires="…",headers="(created) (expires) digest",signature="…"`.
- Verification: parse -> `keyId.subscriber_id == context.bap_id` -> registry lookup (`POST {registry}/lookup {subscriber_id, ukId, country}`; entry must be SUBSCRIBED and inside `valid_from/valid_until`; positive cache 10 min, negative 60 s, transient failures not cached) -> reject future `created` (30 s skew) and past `expires` -> verify over the raw body string as received.
- Signatures on callbacks are made at send time (lifetime `ONDC_SIGNATURE_TTL_SECONDS`, default 300).
- Keys: base64 raw libsodium (ed25519 private = seed||pub, 64 bytes; or bare 32-byte seed), or base64 PKCS8/SPKI DER. Tests pin RFC 8032 test 1 and RFC 7693 (`abc`) vectors plus a fixed-input header vector.
- Gateway `X-Gateway-Authorization` (ADR-021): on `/search` we verify it in addition to the BAP signature, same scheme, over the raw body; the signer is looked up in the registry (`type` must be `BG`, SUBSCRIBED, in its validity window). Required when `ONDC_REQUIRE_GATEWAY_AUTH` is true (default on when `ONDC_ENV=prod`); when present but not required it is still verified, so a forged header is never ignored. Missing/invalid -> 401 NACK 10001, registry outage -> 503.

### Registry onboarding

- `POST /on_subscribe`: registry sends `{subscriber_id, challenge}`; we compute the x25519 shared secret (`ONDC_ENCRYPTION_PRIVATE_KEY` with `ONDC_REGISTRY_ENCRYPTION_PUBLIC_KEY`, the env-specific key ONDC publishes), AES-256-ECB decrypt, answer `{answer}`.
- `GET /ondc-site-verification.html`: `<meta name="ondc-site-verification" content="base64 ed25519(request_id)">`, request id from `ONDC_SITE_REQUEST_ID`. Must be served at the subscriber domain root.

## Catalogue mapping

`getPublicListing`-family reads only (via `listPublicSellerListings`, the LIVE projection); we never query catalogue tables.

| Platform (ListingView) | Beckn |
|---|---|
| `sellerBusinessId` | `provider.id` |
| seller name / city / state | `provider.descriptor.name`, `locations[L1].city/state` |
| min verification tier | `provider.tags[verification].tier` |
| `id` | `item.id` |
| `title`, `description`, `imageUrls` | `descriptor.name` (200), `short_desc` (160), `long_desc` (2000), `images` (8) |
| `hsn` | `descriptor.code = HSN:<hsn>`, tag `b2b.hsn` |
| `pricePaise` | `price.value` decimal string (paise / 100), `maximum_value` same |
| `priceUnit` | `quantity.unitized.measure.unit` (value "1") |
| `moq` / `moqUnit` | `quantity.minimum.count`, tags `b2b.moq`, `b2b.moq_unit` |
| `attributes` | tag list `attributes` (sorted) |
| `language` | tag `b2b.language`; tag `b2b.made_to_order=true` (no inventory count is modelled, so `available` is omitted) |
| category slug | `category_id` via `ONDC_CATEGORY_MAP` JSON (slug -> ONDC id), per-listing override on `OndcListingOptIn.ondcCategoryId`, fallback `Others`. Config/data, never hard-coded (ADR-011). |

Fulfilment is a single `F1` (Delivery) and location `L1`. GST rates are not modelled on the platform yet: taxes are off-platform on the seller invoice; quotes carry item lines only.

**Publish rule** (`ineligibleReason`): seller connected (terms accepted) AND listing opted in AND `status=published` AND `moderationStatus=approved` AND seller `verificationTier >= 1` AND a price. Re-evaluated on every search, so a moderation flip or unpublish takes effect immediately. `publishCatalog` snapshots a hash per seller and emits `OndcCatalogPublished {sellerBusinessId, providerId, items}` in the same transaction only when the projection changed (compare-and-set, so concurrent publishers emit once); disconnecting emits a withdrawal with `items: 0`. Hourly job `ondc.publish-catalogs` reconciles.

## Orders

`/confirm` -> `OndcOrder` (own table; full Beckn payload; unique `(transaction_id, message_id)`; status `created -> accepted -> in_progress -> completed | cancelled`). Prices are recomputed from the live catalogue, never from the request. `OndcOrderReceived {ondcOrderId, orderId, sellerBusinessId, bapId, transactionId}` is emitted exactly once (guard column `receivedEmittedAt`).

Mirroring to the enquiry `Order` model is a port: `setOrderSink({ recordExternalOrder })`, default `null` (orders stay in the ONDC inbox). Enquiry today requires `matchId/enquiryId`, so the lead must add an enquiry public function (see the build report): create an Order with `settlement="ondc"`, no match, idempotent on `externalRef`. A sink failure never loses the order and never blocks `on_confirm`: the row is re-offered on redelivery, so sinks MUST be idempotent on `externalRef = "ondc:<ondcOrderId>"`.

Seller inbox (`/ondc/orders`): accept (`on_status` with state Accepted) or reject (`on_cancel`, reason code 011). Buyer `cancel` is honoured from `created`/`accepted`. Later order status changes are mirrored back as unsolicited `on_status` (see Fulfilment status push).

## Queue, retries and failure handling

Topics (declaration-merged `JobTopics`): `ondc.inbound {messageId}` and `ondc.callback {messageId}`, consumed by `worker` (module `ondc`). Callback bodies are stored first (`OndcMessage`), so they are replayable; signing happens at delivery. Transient failures (network, 5xx, 429) throw and use core backoff then dead-letter; a BAP NACK or a non-public callback URL is a permanent `failed` row shown in the admin console with a Replay button (`ondc.manage`, audited).

## Security and compliance

- Private keys only from env / secrets provider (`ONDC_SIGNING_PRIVATE_KEY`, `ONDC_ENCRYPTION_PRIVATE_KEY`); never stored in the DB or shown in the admin UI (status shows configured/missing only).
- SSRF: `context.bap_uri` is attacker-influenced, so callbacks go through `assertPublicHttpUrl` (https only; http only in non-prod with `ONDC_ALLOW_HTTP`).
- Impersonation: the signer identity must equal `context.bap_id`; registry key must be SUBSCRIBED and in its validity window.
- Rate limits at the route (600/min/IP inbound, 30/min on_subscribe), 512 KB body cap, strict zod shapes.
- DPDP (ADR-010): protocol messages contain buyer contact/billing. Admin views redact `billing`, `contact`, `end`, `phone`, `email`, `address`, `gps`, `name` (except catalogue names). Job `ondc.purge-messages` deletes messages older than 90 days. `OndcOrder.payload` follows the order's own retention: register it with `@cnote/compliance` before go-live. Data stays in India regions.
- Seller consent: explicit terms acceptance (`TERMS_VERSION`), recorded with person and timestamp on `OndcSeller`.

## Live participation (ADR-021)

### Fulfilment status push

The worker observes `OrderStatusChanged`. For a platform order with an ONDC mirror (`OndcOrder.internalOrderId`), the status maps to a Beckn fulfilment state and an unsolicited, signed `on_status` is queued on `ondc.callback` (same retry/dead-letter path):

| platform status | fulfilment state | ONDC order state |
|---|---|---|
| confirmed (only if the order was still `created`, i.e. accepted on the platform side) | Packed | Accepted |
| dispatched | Order-picked-up | In-progress |
| delivered | Order-delivered | In-progress |
| completed | Order-delivered | Completed |
| cancelled (unless already cancelled through the inbox) | Cancelled | Cancelled |

`recorded` is not pushed; inbox accept/reject already sent their own callback and the handler skips them. Idempotent per (order, state): the `message_id` is a deterministic uuid of (order, fulfilment state, order state) and outbound rows are unique on it; states never move backwards. `OndcOrder.fulfilmentState` also feeds `on_status` replies to buyer `status` calls (`fulfillments[].state.descriptor.code`). Out-for-delivery and in-transit now have a platform trigger: the seller records fulfilment sub-stages on the order (packed, in_transit, out_for_delivery, delivery_attempted; `OrderFulfilmentUpdated`, they never change the main order status, so escrow is unaffected). The worker maps them with `onOrderFulfilmentUpdated`: packed -> Packed, in_transit -> Order-picked-up (retail has no separate In-transit code, so it dedupes against the dispatch push), out_for_delivery -> Out-for-delivery; delivery_attempted has no Beckn state and pushes nothing. Same rules as the status push: idempotent per (order, state), never backwards, skipped for orders still `created`/cancelled/completed, kill-switch aware. Seller UI: `(portal)/ondc/orders` shows the Beckn fulfilment state per order and links to the platform order where the seller records the steps.

### IGM (issue and grievance management)

Endpoints (same signed-request pipeline, same `/ondc/{action}` route): `POST /ondc/issue`, `POST /ondc/issue_status`. We ACK synchronously and answer `on_issue` / `on_issue_status` to `bap_uri` (same callback queue; IGM core_version follows the request, default 1.0.0).

```
issue          -> OndcIssue (unique bap_id + issue.id) -> dispute opened via @cnote/disputes.openDispute
                  (opener = ONDC system buyer business, respondent = seller) -> OndcIssueReceived (once) -> on_issue PROCESSING
issue (again)  -> re-ack with current state; issue.status CLOSED -> dispute withdrawn (if still withdrawable), issue closed
issue_status   -> on_issue_status with respondent_actions (+ resolution when resolved)
DisputeEscalated -> on_issue_status PROCESSING "escalated to human review"
DisputeResolved  -> on_issue_status RESOLVED + resolution {action_triggered REFUND|NO-ACTION, refund_amount}
TTL job (10 min) -> resolution TTL exceeded -> on_issue_status CASCADED (level 2), once
```

Mapping: `order_details.id` = the `OndcOrder.id` we returned as `order.id` (must belong to the same BAP, else `on_issue` error 30004). Dispute type from category/sub-category (`disputeTypeFor`: ITEM ITM01/04 quantity_short, ITM02 quality_mismatch, ITM03 wrong_item, ITM05/06 damaged, FULFILLMENT/ORDER non_delivery, PAYMENT payment_issue, else other; best effort, reconcile with the IGM sheet). Outcome: buyer_favour/split with a refund -> REFUND with `refund_amount`; seller_favour -> NO-ACTION. TTLs: `expected_response_time` / `expected_resolution_time` from the request, else `ONDC_IGM_RESPONSE_TTL` (PT1H) / `ONDC_IGM_RESOLUTION_TTL` (PT24H). We answer `on_issue` at receipt, so the response TTL is met by the worker turnaround; `expectedResponseAt` is kept for audit.

**Gap: manual fallback.** `openDispute` needs a platform order in `confirmed/dispatched/delivered/completed` and `DISPUTES_ENABLED`. When the issue arrives for an order with no mirror (sink not wired), still `recorded`, or with disputes off, the issue is stored with `needsManual = true` and no dispute; the network is still answered (PROCESSING) and staff resolve it in the admin console ("Network issues" table, Resolve), which pushes `on_issue_status` RESOLVED (audited). Issues with a live dispute must be resolved through the dispute. ADR-013 has no "external opener" concept: the system buyer business plus a zero person id is used as the actor (no FK on the person column); if disputes later require a real person, add a system person.

DPDP: `OndcIssue.payload` holds the complainant contact; `ondc.purge-messages` strips resolved/closed issue payloads (to the Beckn context only) after 90 days. Register `OndcIssue`/`OndcOrder` payloads with `@cnote/compliance`.

### Kill switch

`OndcControl` row `killswitch` (DB, no redeploy), toggled in the admin console (ondc.manage, audited in `AdminAuditLog`, note stored). While on: every inbound action is NACKed 503 (retryable, error 20000 "suspended"), catalogue publishing and the `on_search` projection are empty, the worker skips inbound processing and callback delivery (rows stay `received`/`pending`), fulfilment and IGM pushes are not queued, the TTL job is a no-op. `/on_subscribe` and site verification keep working. Releasing re-queues parked inbound and outbound rows (`resumePending`). The state is cached 3 s per process.

### Evaluation (ADR-021, two quarters)

`ondcEvaluation(from, to)` returns incremental GMV (non-cancelled ONDC orders; network buyers have no platform business, so all of it is GMV the platform did not have from its own buyers; overlap with existing buyers is not observable), GMV by month, order counts, issue counts by category/status, issues and disputes per 100 orders, share resolved within TTL and median resolution hours. The admin page shows the last 90 days.

### Readiness checklist

The admin ONDC page shows automatic checks (keys present, registry encryption key, subscribed in the registry with our signing key, site verification served, gateway auth required, order sink wired, disputes enabled, grievance officer contact, category map, environment) and manual certification items (`cert.*` rows, ticked by staff, audited).

## Go-live runbook

1. Staging: set env (below) on api + worker + admin, `DISPUTES_ENABLED=true`, `ONDC_GRO_EMAIL/PHONE`; the order sink is wired in the composition roots. Keep `ONDC_ENABLED=false` until the admin readiness page shows the automatic checks green.
2. Register on the ONDC staging registry (subscriber id, unique key id, keys, B2B domain code, city codes); complete `/on_subscribe`; confirm `/ondc-site-verification.html`.
3. Set `ONDC_ENABLED=true` (staging) and run the ONDC log-verification suite for search, select, init, confirm, status, cancel, unsolicited on_status, and IGM (issue, on_issue, issue_status, on_issue_status). Tick the checklist items in admin as each passes.
4. Pre-prod, then prod: `ONDC_ENV` changes the registry URL and turns gateway auth on by default; verify the gateway header against the ONDC gateway before prod.
5. Pilot with a few verified (tier >= 1) sellers. Watch failed callbacks, dead-lettered `ondc.*` topics and overdue issues. Use the kill switch first, investigate second.
6. Two quarters of `ondcEvaluation` before deciding on buyer-side participation.

## Still needs ONDC certification / decisions

B2B domain code and city codes (defaults are the retail domain `ONDC:RET10`); error-code sheet reconciliation (including IGM errors); IGM sub-category codes and the `resolution_provider` shape against the current IGM spec (this build follows IGM 1.0 field names; IGM 2.0 differs); the gateway registry type (`BG`) and header handling against the staging gateway; the log-verification suites; seller-recorded fulfilment states are manual (no courier integration or webhooks yet), and `delivery_attempted` / RTO / Undeliverable have no Beckn mapping; GST in quotes; legal review of the seller terms (`TERMS_VERSION` 2026-10-v1 now describes network grievance handling through IGM and disputes, replacing "handled outside the network"; sellers who accepted the earlier version must re-accept to reconnect).

## Configuration

`ONDC_ENABLED` (false), `ONDC_ENV` (staging|preprod|prod), `ONDC_REGISTRY_URL` (override), `ONDC_SUBSCRIBER_ID`, `ONDC_UNIQUE_KEY_ID`, `ONDC_SUBSCRIBER_URL`, `ONDC_SIGNING_PRIVATE_KEY`, `ONDC_ENCRYPTION_PRIVATE_KEY`, `ONDC_ENCRYPTION_PUBLIC_KEY`, `ONDC_REGISTRY_ENCRYPTION_PUBLIC_KEY`, `ONDC_SITE_REQUEST_ID`, `ONDC_DOMAINS` (`ONDC:RET10`), `ONDC_CITY_CODES` (`*`), `ONDC_COUNTRY` (IND), `ONDC_CORE_VERSION` (1.2.0), `ONDC_TTL` (PT30S), `ONDC_SIGNATURE_TTL_SECONDS` (300), `ONDC_ALLOW_HTTP`, `ONDC_CATEGORY_MAP` (JSON), `ONDC_REQUIRE_GATEWAY_AUTH` (true in prod), `ONDC_IGM_RESPONSE_TTL` (PT1H), `ONDC_IGM_RESOLUTION_TTL` (PT24H), `ONDC_GRO_NAME`, `ONDC_GRO_EMAIL`, `ONDC_GRO_PHONE`. The kill switch and certification items live in the database (`OndcControl`), not env.

## Go-live checklist (ADR-021)

1. ADR-013 disputes enabled (IGM issues open disputes) and ONDC terms reviewed by legal.
2. Participant registered on ONDC (staging -> pre-prod -> prod): subscriber id, unique key id, domains and city codes confirmed; error-code sheet reconciled; domain code for B2B confirmed.
3. Keys generated (`generateSigningKeyPair`, `generateEncryptionKeyPair`), private keys in the secrets provider, public keys submitted; `ONDC_REGISTRY_ENCRYPTION_PUBLIC_KEY` set for the environment.
4. `/on_subscribe` and `/ondc-site-verification.html` reachable on the subscriber domain (admin console shows Ready).
5. ONDC test-harness/log-verification suite passes for search, select, init, confirm, status, cancel.
6. Order sink wired to enquiry (`settlement="ondc"`); fulfilment status mirror verified in the log suite.
7. Category map (`ONDC_CATEGORY_MAP`) reviewed for the launch vertical (ADR-011).
8. Retention for `OndcOrder.payload` registered with compliance; alerts on failed callbacks and dead-lettered `ondc.*` topics.
9. Pilot with a handful of verified (tier >= 1) sellers; `ONDC_ENABLED=true` on api + worker in staging first; measure incremental GMV and dispute load for two quarters before evaluating buyer-side participation (ADR-021).

### Seller network issues

`(portal)/ondc/issues` lists issues raised against the seller's ONDC orders (`listSellerIssues`: category, status, response/resolution TTLs, overdue flag, manual-handling flag) and `issues/[id]` shows the detail: what the buyer reported, deadlines, the resolution (action, refund amount) and a link to `(portal)/disputes/[id]` when a dispute is open. The complainant contact (`payload`) is never exposed. It is read-only: the seller responds and adds evidence in the dispute; manual-fallback issues are resolved by staff.

## Design research (Mobbin)

- Delivery tracking: [Urban Outfitters "Track your package"](https://mobbin.com/screens/640f7618-77c5-44f4-abdb-2f7f3e413fad) (Shipped / On its way / Out for delivery / Delivered stepper, courier tracking number, "Latest update" history) and [adidas order status](https://mobbin.com/screens/fcff9285-bb90-4bee-aae9-547cbcf6b26d) (three-step header with the carrier in order details). Adopted: a step list with the state written out as text, a tracking line (courier + AWB) and a newest-first update history, on the buyer and seller order pages.
- Issue lists: [Zendesk ticket list](https://mobbin.com/screens/6d092d6c-e458-4351-9bf5-d88a8d095750) and [Sentry issues](https://mobbin.com/screens/cbeb79af-db33-40f6-ad1b-06ab18062309). Adopted: one card per issue with a status badge, age and deadline, and a details link.

- Channel connect card with status badge, explicit enable/disable and a settings-style layout: [Klaviyo Shopify integration](https://mobbin.com/screens/076861ae-6e40-4888-890a-58bb816b10cf), [Canny Slack integration](https://mobbin.com/screens/13cb3b15-e24a-4550-8719-62bc12ebf5cc), [Gemini connected apps toggles](https://mobbin.com/screens/e90f55bd-da8b-4882-b8ab-591857e2b74c). Adopted: status badge plus a single primary connect/disconnect action, terms shown before connecting, per-item toggle list.
- Incoming orders inbox: [Shopify orders list](https://mobbin.com/screens/909c6cdb-f0a1-4183-ab1c-b64f3f2c9aa2), [Midday inbox](https://mobbin.com/screens/bb6dcd6c-9b61-4382-a0d8-401ce16b6247). Adopted: a compact card per order with amount and status badge, with the decision (accept/reject) inline on rows that need it.
