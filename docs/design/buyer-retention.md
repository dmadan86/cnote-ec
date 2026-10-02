# Buyer retention (buyer web)

Status: implemented. Related: ADR-000/009 (ranking never changes), ADR-002 (preferred-seller bump only), ADR-007 (event log), ADR-010 (DPDP), `docs/design/cookie-consent.md`, `docs/design/buyer-convenience.md`.

## Mobbin references

Mobbin had few direct hits for these patterns, so only what matched is adopted:

- Alert settings: Square "Alerts" list with one checkbox per alert type and an explicit Save (<https://mobbin.com/screens/5eb342dc-d666-4d38-80cd-cdea2f21ab52>) and Klaviyo "Notifications" with a checkbox plus Immediately / daily / weekly radios (<https://mobbin.com/screens/0fdf7cf8-57e8-4874-b09b-c05d28f87bb5>). Adopted: one labelled checkbox per type with a description, and daily/weekly as a radio group. Changed: everything defaults OFF (opt-in), no "immediately" option (digests only, to limit noise).
- Re-order: H&M "Order details" (<https://mobbin.com/screens/4f0f2cc7-5e9e-4ee7-8bdd-4910d54066bc>) and DoorDash Merchant order history (<https://mobbin.com/screens/3de8fe76-e958-4784-9100-8b45fbd80cf5>): the action sits with the order header. Adopted: "Request again" in the page-header actions. Changed: it opens a prefilled form instead of creating anything, because a B2B requirement needs review (price, quantity, supplier).
- Follow a seller / saved-search results returned no usable match; the follow button copies the existing pressed-toggle pattern of the wishlist heart (`aria-pressed`, per-visitor state fetched after hydration).

## Module: `@cnote/alerts`

A small new module (ADR-006 graph: `core`, `db`, `catalogue`, `identity`, `search`, `wishlist`; `notifications` and `compliance` depend on it, nothing else). It owns `alerts.prisma`: `SupplierFollow`, `SavedSearch`, `AlertSettings`, `AlertDispatch`. It was not folded into `wishlist` because it needs `search`, and wishlist should stay a leaf under `catalogue`.

- It decides WHAT is new and emits `BuyerAlertTriggered` (catalogue v1, same transaction as the state change). `@cnote/notifications` delivers it (four kinds `alert.*`, category `alerts`, templates editable in the studio), so preferences, the template studio and the email log all apply.
- Nothing here feeds ranking. Following, saved searches and alerts are private; sellers see only an aggregate follower count on the seller dashboard (`countFollowers`).

## Features

- **Follow**: button on the supplier profile and the PDP seller card (client island; state from `GET /api/follow/<id>`, private, no-store; the static HTML never carries per-person state). `/buyer/suppliers` lists followed suppliers with their newest live listings and an unfollow button. Max 200 follows.
- **Weekly digest** (job `alerts.followed-digests`, hourly tick): new listings (LIVE `createdAt` = first publication) from followed suppliers since the person's cursor, restricted to the buyer's categories (categories of saved items and saved searches; unknown = unrestricted). Opt-in (`AlertSettings.followedDigest`).
- **Saved searches**: "Save this search" on `/search` stores query + normalised filters + sort (`SearchFilters` from the URL). Listings matching at save time are recorded as seen. Job `alerts.saved-search-digests` re-runs the search through `searchListings` (sort `newest`) and reports ids not yet seen; daily or weekly per search, default `off`. Managed at `/account/saved-searches`. Max 20 per person; duplicates refused.
- **Price drop / back in stock** on wishlist items: catalogue now emits `ListingPriceChanged` v1 (from/to paise and units) in the publish transaction, only on a real change (never the first publish). `ListingPublished` fires again when an unpublished listing returns, which is the back-in-stock trigger. The handlers use `wishlist.listSaversOfListing`, skip raises, price-on-request and unit changes, and only touch people who opted in.
- **Request again**: link on `/buyer/enquiries/<id>` (closed, quoted or expired) and `/buyer/orders/<id>` to `/rfq/new?again=<enquiryId>&order=<orderId>`. The server loads the buyer's OWN enquiry/order through the enquiry module (others' ids give an empty form), prefills title, requirement, category, quantity, unit, target price, delivery city/pincode, budget, tier floor, and offers "Send to <supplier> first" (checked). That sets `preferredSellerId`, the existing matching bump (ADR-002); other suppliers can still match. The new enquiry is only created when the buyer submits.

## Idempotency

- Digests claim their window with a compare-and-set on the cursor (`SavedSearch.lastRunAt`, `AlertSettings.followedDigestAt`) in the transaction that emits the event: re-runs and concurrent workers notify once.
- Event handlers claim `(kind, event id, person)` in `AlertDispatch` (skipDuplicates) in the emitting transaction. The notification pipeline is idempotent per (person, kind, event) as well.

## Preferences, consent and unsubscribe

- Opt-in per type lives in `AlertSettings` (all false); saved-search alerts are opt-in per search (`frequency` defaults to `off`). Choosing daily/weekly also makes sure at least one channel is on.
- Channel choice (in-app / email) is the new notification category `alerts` (listed in `/account/notifications` and `/account/alerts`). Kinds re-check the opt-in at resolve time, so an unsubscribe applies to alerts already queued.
- Email template category `alert`: footer unsubscribe link and `List-Unsubscribe` header, no marketing consent needed because each type is individually opted into. The link is `/unsubscribe/alerts?t=<HMAC(person, type)>` (non-expiring, can only switch that type off). A GET only shows a confirmation; the POST (server action) switches it off, so mail scanners cannot unsubscribe anyone.

## DPDP

- Export: `/account/export` adds `followedSuppliers`, `savedSearches`, `alertSettings`.
- Erasure: `DataErasureRequested` handler deletes follows, saved searches, settings and dispatch rows.
- Retention: dispatch ledger rows purge after 90 days (`alerts.dispatch_ledger_90d`).
- Browser storage: none added (no cookie-consent registry entry needed); the follow state is fetched, not stored.

## Accessibility

Native checkboxes/radios/selects with labels and descriptions, `aria-pressed` toggles, polite status regions, 44px targets, no information by colour alone. Covered by `e2e/a11y/buyer-retention.spec.ts` (axe + keyboard).
