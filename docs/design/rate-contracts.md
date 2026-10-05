# Rate contracts and call-off orders

Status: built, on by default (`RATE_CONTRACTS_ENABLED`). Owner: `@cnote/enquiry` (orders sub-module). Builds on purchase orders (`docs/design/purchase-orders.md`). Phase 1 settles off-platform (ADR-007): a rate contract is a commercial agreement and a record, no money moves through it.

## What it does

1. **Contract.** Agreed prices between ONE buyer business and ONE seller business for a period and optionally a volume: validity (from/to, up to 5 years), currency INR, payment terms in days, price basis (ex-works, for-destination, delivered, other), an optional cap on total taxable value and 1 to 50 items. Number `RC/26-27/000003`, per buyer business and Indian financial year.
2. **Item.** Catalogue reference (optional, must be a published product of that seller) or free text; unit; unit price in paise before GST; GST rate; HSN; MOQ per call-off; optional quantity cap; price variation: `fixed`, or `indexed` with a cap in percent (max 50%) and a reference description (e.g. "LME copper monthly average").
3. **Negotiation.** The buyer starts from scratch or by converting an accepted quote ("convert to rate contract"), reviews a private draft and sends it. The seller can accept, decline (reason) or counter-propose. Every change is a new immutable **revision**; a revision is in force only when BOTH parties have accepted it. The proposer's acceptance is recorded with the revision; the other party answers. A newer proposal supersedes a pending one.
4. **Amendments.** Same mechanism on an active contract: the accepted terms stay in force until the other side accepts the amendment. Earlier call-offs keep the price they were placed at. Guards: items with call-offs cannot be removed or change unit, quantity caps and the value cap cannot go below what is consumed, the start date cannot move once the contract has started.
5. **Call-off.** The buyer picks items and quantities on an active contract inside its dates and gets an Order (buyer pre-confirmed) and, while `PURCHASE_ORDERS_ENABLED`, a PO issued at the locked prices, with no RFQ. Fixed prices cannot be overridden; an indexed item may be called off within +/- its cap (the seller still accepts or rejects the PO). MOQ per call-off, per-item quantity caps and the value cap are enforced under a row lock, so parallel call-offs cannot overshoot. A client idempotency key makes retries safe (web form, API).
6. **Consumption and alerts.** Consumed = lines of call-offs still `placed`; cancelling the order releases its quantities. Crossing 80% and 100% of an item cap or of the value cap emits one `RateContractConsumptionWarning` per scope and threshold (when a call-off jumps past both, only 100% is announced). An hourly job (`enquiry.rate-contract-sweep`) expires ended contracts and sends expiry reminders 30 and 7 days before the end (only the current stage if the job was down; each recorded once in `rate_contract_alerts` in the same transaction as the event).
7. **Terminate / renew.** Either party can terminate with a reason (orders already placed stand); a buyer can discard an unsent draft silently. A renewal is an explicit buyer action that creates a NEW draft (same terms, period shifted after the old end, `renewedFromId`) which both parties must accept again.

## Decisions

- **No auto-renew, at all (ADR-005 spirit).** There is no auto-renew column or flag. Expiry notifications say the contract "will not renew by itself" and point to renewal or an agreed extension (an amendment that moves the end date). A schema test asserts the only renewal-related column is `renewed_from_id`.
- **Lives in `@cnote/enquiry`**, not a new package: it creates Orders and POs in the same module, and ADR-006 forbids cross-module table access. Tables are in `orders.prisma`.
- **Immutable revisions; a draft's revision 1 is the one exception** (replaced in place until sent, because nobody else has seen it). Acceptances are append-only in practice (no triggers; like PO acks); retention is the only writer that blanks person references.
- **Initial rejection keeps the proposal open** (status stays `proposed`, the revision shows as declined). Either party can then propose a changed revision, or terminate. Rejecting an amendment leaves the active terms untouched.
- **Quote conversion** needs the quote's lead to be accepted and the actor to be its buyer. A GST-inclusive quote price is converted to a price before GST at the default 18% (`suggestFromQuote`); the buyer edits the draft before sending.
- **Call-off order shape.** `matchId`/`enquiryId` are null; a single-line call-off also fills the order's quantity/price/unit, a multi-line one leaves them null (the PO carries the lines). `OrderRecorded` is NOT emitted (its payload requires a match); `RateContractCallOffPlaced` is the event. Order pages title these orders "Call-off N on RC/...".
- **PO failures do not undo a call-off.** Address, date and terms are validated before the transaction; if issuing the PO still fails, the call-off stands and the result carries `purchaseOrderError` so the buyer can issue it from the order page.
- **Price variation is bounded and visible.** `indexed` items carry the cap and a reference text, shown to both parties; the platform does not look up indices.
- **Private (ADR-005 / ADR-009).** Nothing in ranking, lead matching, search, trust score or ads reads contract data. `rate-contracts-ranking.test.ts` greps those sources, asserts only `enquiry` (and the generated client) touches the tables, and proves lead ranking ignores smuggled contract fields. Seller-side lists and gets hide a buyer's unsent drafts; notification copy never names the counterparty.
- **A2A mandates (`@cnote/a2a`) and negotiation assist (`@cnote/negotiation`) are untouched.** External agents can read contracts and place call-offs through the API with `contracts:*` scopes but cannot create, change or accept a contract (needs the business's people). Agents never move price outside the contract.
- **Feature flag** `RATE_CONTRACTS_ENABLED` (default on; false/0/off hides screens and the API, blocks writes, stops the sweep; data kept). Not Phase-2-ish: no money moves.

## Data model (`orders.prisma`, migrations `20261005195206_rate_contracts`, `20261005200250_rate_contracts_idempotency`)

`rate_contracts`, `rate_contract_sequences`, `rate_contract_revisions`, `rate_contract_items`, `rate_contract_acceptances`, `rate_contract_call_offs` (unique `(contract, idempotency_key)`), `rate_contract_call_off_lines`, `rate_contract_alerts`. Money is `BigInt` paise; dates are `@db.Date` (Indian dates).

## Events (versioned, in `catalog.ts`, all v1)

`RateContractProposed`, `RateContractActivated`, `RateContractRejected`, `RateContractTerminated`, `RateContractExpired`, `RateContractCallOffPlaced`, `RateContractCallOffReleased`, `RateContractConsumptionWarning`, `RateContractExpiryReminder`. Emitted with `emit(tx, ...)` in the state-change transaction; payloads hold ids, number, dates, paise and percentages, never terms text, addresses or GSTINs.

## Notifications (`packages/notifications/src/kinds-contracts.ts`, en + hi defaults, editable in the template studio)

`contract.proposed`, `contract.amended`, `contract.activated`, `contract.rejected`, `contract.terminated`, `contract.expired`, `contract.call_off`, `contract.usage_80`, `contract.usage_100`, `contract.expiry_30`, `contract.expiry_7`. All transactional ("messages").

## Public API (`apps/api`, OpenAPI regenerated)

Scopes `contracts:read` and `contracts:write` (both need a business-bound key). `GET /v1/contracts?role=&status=`, `GET /v1/contracts/{id}`, `POST /v1/contracts/{id}/call-offs` (buyer, required `Idempotency-Key`). Creating/amending/accepting contracts is deliberately not exposed. MCP tools are not added (follow-up).

## Screens

- Buyer web (WCAG 2.2 AA, en + hi, plus the six catalogues kept on disk): `/buyer/contracts` list, `/new`, `/[id]` detail (terms in force, pending revision, history, consumption, call-offs, terminate, renew), `/[id]/call-off`. Status and thresholds are text, never colour alone; progress bars carry `aria-valuenow`. axe spec: `e2e/a11y/contracts.spec.ts`.
- Seller app (8 locales): `/contracts` list and `/contracts/[id]` (answer, counter-propose, consumption, terminate). Sellers cannot create contracts or call off.

### Mobbin references adopted

- Contract detail with line table, side cards for terms and cost summary: [Shopify purchase order](https://mobbin.com/screens/4d6a46fc-c238-457d-ad79-58d4ee90282d).
- Contract creation with name/notes table, payment block and clause list: [Square New contract](https://mobbin.com/screens/69dc6b2c-243c-4459-bfeb-7b7ac0215fd6), [Square contract terms](https://mobbin.com/screens/d723a96f-2760-436e-9126-d65e0a590d55).
- Contract list with status filter and status column: [HoneyBook files](https://mobbin.com/screens/906dff27-49b0-4d21-bac0-7ffe6d027aa7).
- Reorder: per-item quantity inputs with line totals: [Shopify edit order](https://mobbin.com/screens/7e0840a7-ab66-4ca1-a92f-1d4b968103e7), [HoneyBook add service](https://mobbin.com/screens/467a9e27-f6f0-4f5b-950a-936cf4d8f691) (qty, unit, price, total per row).
- Adapted to `@cnote/ui` tokens; no pasted layouts.

## DPDP

- **Export:** `exportPersonalData` now includes `rateContracts` (revisions, items, the requester business's own answers, call-offs and lines). The seller side never receives a buyer's unsent draft or the counterparty's answers.
- **Retention:** `enquiry.rate_contracts_7y` (`RETENTION_RATE_CONTRACTS_DAYS`, default 2555) for expired/terminated contracts: person references on revisions, answers and call-offs are cleared and notes, change notes, decline reasons and the termination reason blanked; numbers, parties, dates, prices, quantities and call-offs stay (they back orders, POs and invoices kept for tax).

## Not done / follow-ups

- MCP tools for contracts; admin read-only view.
- Auto-suggesting a rate contract from repeated orders; applying contract prices to catalogue price tiers.
- Index lookups for indexed prices (the cap and reference are agreed text only).
- Emitting `OrderRecorded` v2 with nullable match/enquiry for call-off orders.
- Multiple sellers per contract, per-site delivery schedules, and e-signature.
