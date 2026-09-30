# ONDC seller-network-participant adapter (ADR-017)

Status: built, **not live on the network**. Flag `ONDC_ENABLED` defaults to `false`; with it off the API routes return 404, nothing is published, and every worker consumer/job is a no-op. Going live is ADR-021 and depends on ADR-013 (dispute capacity).

Package `@cnote/ondc` (`packages/ondc`), schema `packages/db/prisma/schema/ondc.prisma`, routes `apps/api/src/routes/ondc`, seller UI `apps/seller/src/app/(portal)/ondc`, admin UI `apps/admin/src/app/(console)/ondc`.

## Scope

Seller-side only (BPP): we expose opted-in catalogue and receive orders. The buyer experience stays first-party (ADR-017). Out of scope now: IGM (issues and grievances), buyer-side participation, payments settlement on the network, logistics (ONDC LSP) fulfilment.

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
- Gateway `X-Gateway-Authorization` is not verified (BAP signature is); add if ONDC certification requires it.

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

Seller inbox (`/ondc/orders`): accept (`on_status` with state Accepted) or reject (`on_cancel`, reason code 011). Buyer `cancel` is honoured from `created`/`accepted`. Order status changes after accept (dispatch/completion) are not yet mirrored back from enquiry: Phase 3 follow-up together with the sink.

## Queue, retries and failure handling

Topics (declaration-merged `JobTopics`): `ondc.inbound {messageId}` and `ondc.callback {messageId}`, consumed by `worker` (module `ondc`). Callback bodies are stored first (`OndcMessage`), so they are replayable; signing happens at delivery. Transient failures (network, 5xx, 429) throw and use core backoff then dead-letter; a BAP NACK or a non-public callback URL is a permanent `failed` row shown in the admin console with a Replay button (`ondc.manage`, audited).

## Security and compliance

- Private keys only from env / secrets provider (`ONDC_SIGNING_PRIVATE_KEY`, `ONDC_ENCRYPTION_PRIVATE_KEY`); never stored in the DB or shown in the admin UI (status shows configured/missing only).
- SSRF: `context.bap_uri` is attacker-influenced, so callbacks go through `assertPublicHttpUrl` (https only; http only in non-prod with `ONDC_ALLOW_HTTP`).
- Impersonation: the signer identity must equal `context.bap_id`; registry key must be SUBSCRIBED and in its validity window.
- Rate limits at the route (600/min/IP inbound, 30/min on_subscribe), 512 KB body cap, strict zod shapes.
- DPDP (ADR-010): protocol messages contain buyer contact/billing. Admin views redact `billing`, `contact`, `end`, `phone`, `email`, `address`, `gps`, `name` (except catalogue names). Job `ondc.purge-messages` deletes messages older than 90 days. `OndcOrder.payload` follows the order's own retention: register it with `@cnote/compliance` before go-live. Data stays in India regions.
- Seller consent: explicit terms acceptance (`TERMS_VERSION`), recorded with person and timestamp on `OndcSeller`.

## Disputes: IGM is Phase 3

ONDC IGM (issue and grievance management: `issue`, `on_issue`, `issue_status`, L1/L2/GRO escalation, resolution SLAs) is not implemented. ONDC disputes are unbundled (buyer app, seller app and logistics each own a part), so they cannot be absorbed by the Phase-2 disputes module (ADR-013) as is. Dependency for ADR-021: ADR-013 needs an external-case intake (from `issue`) and outcome push (`on_issue` resolution), plus reviewer capacity. Until then, seller-facing ONDC terms state that grievances are handled outside the network, and going live is blocked on this.

## Configuration

`ONDC_ENABLED` (false), `ONDC_ENV` (staging|preprod|prod), `ONDC_REGISTRY_URL` (override), `ONDC_SUBSCRIBER_ID`, `ONDC_UNIQUE_KEY_ID`, `ONDC_SUBSCRIBER_URL`, `ONDC_SIGNING_PRIVATE_KEY`, `ONDC_ENCRYPTION_PRIVATE_KEY`, `ONDC_ENCRYPTION_PUBLIC_KEY`, `ONDC_REGISTRY_ENCRYPTION_PUBLIC_KEY`, `ONDC_SITE_REQUEST_ID`, `ONDC_DOMAINS` (`ONDC:RET10`), `ONDC_CITY_CODES` (`*`), `ONDC_COUNTRY` (IND), `ONDC_CORE_VERSION` (1.2.0), `ONDC_TTL` (PT30S), `ONDC_SIGNATURE_TTL_SECONDS` (300), `ONDC_ALLOW_HTTP`, `ONDC_CATEGORY_MAP` (JSON).

## Go-live checklist (ADR-021)

1. ADR-013 IGM prerequisite met (see above) and ONDC terms reviewed by legal.
2. Participant registered on ONDC (staging -> pre-prod -> prod): subscriber id, unique key id, domains and city codes confirmed; error-code sheet reconciled; domain code for B2B confirmed.
3. Keys generated (`generateSigningKeyPair`, `generateEncryptionKeyPair`), private keys in the secrets provider, public keys submitted; `ONDC_REGISTRY_ENCRYPTION_PUBLIC_KEY` set for the environment.
4. `/on_subscribe` and `/ondc-site-verification.html` reachable on the subscriber domain (admin console shows Ready).
5. ONDC test-harness/log-verification suite passes for search, select, init, confirm, status, cancel.
6. Order sink wired to enquiry (`settlement="ondc"`); status mirror back to ONDC agreed.
7. Category map (`ONDC_CATEGORY_MAP`) reviewed for the launch vertical (ADR-011).
8. Retention for `OndcOrder.payload` registered with compliance; alerts on failed callbacks and dead-lettered `ondc.*` topics.
9. Pilot with a handful of verified (tier >= 1) sellers; `ONDC_ENABLED=true` on api + worker in staging first; measure incremental GMV and dispute load for two quarters before evaluating buyer-side participation (ADR-021).

## Design research (Mobbin)

- Channel connect card with status badge, explicit enable/disable and a settings-style layout: [Klaviyo Shopify integration](https://mobbin.com/screens/076861ae-6e40-4888-890a-58bb816b10cf), [Canny Slack integration](https://mobbin.com/screens/13cb3b15-e24a-4550-8719-62bc12ebf5cc), [Gemini connected apps toggles](https://mobbin.com/screens/e90f55bd-da8b-4882-b8ab-591857e2b74c). Adopted: status badge plus a single primary connect/disconnect action, terms shown before connecting, per-item toggle list.
- Incoming orders inbox: [Shopify orders list](https://mobbin.com/screens/909c6cdb-f0a1-4183-ab1c-b64f3f2c9aa2), [Midday inbox](https://mobbin.com/screens/bb6dcd6c-9b61-4382-a0d8-401ce16b6247). Adopted: a compact card per order with amount and status badge, with the decision (accept/reject) inline on rows that need it.
