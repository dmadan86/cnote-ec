# Agent-to-agent commerce (ADR-020)

Package `@cnote/a2a`, schema `packages/db/prisma/schema/a2a.prisma`, flag `A2A_ENABLED` (default off). External API: `docs/api/agents.md`. Extends ADR-014 (`docs/design/negotiation.md`): the quote-assist agent and the price book are reused, not replaced.

Standing agents act for a business inside a **mandate** the business wrote. A buyer agent and a seller agent negotiate with a **typed protocol** (not free text). An agreed negotiation is a *proposal*: it becomes a real Quote and Order only when each principal confirms, or auto-accepts inside bounds it set itself. Third-party procurement agents use the same protocol through API keys.

## Guardrails (non-negotiable, ADR-014/020)

| Rule | How it is enforced |
| --- | --- |
| Explicit opt-in, revocable, logged | A mandate needs `optIn: true` (stored as `consentedAt`). Pause, resume, revoke at any time (open negotiations of that mandate are withdrawn). Every change appends an `AgentMandateChange` row with the resulting terms and who did it. Editing never touches negotiations already running: each negotiation snapshots both sides' bounds at start. |
| Auto-accept off by default | `autoAccept=false` unless the principal turns it on with a separate consent (`autoAcceptConsentAt`) and a limit that is tighter than or equal to the hard bound (buyer: ceiling <= maximum price; seller: minimum >= floor). Turning it off is one call. The API cannot turn it on. |
| Server-side bounds on both sides | `protocol.step()` is pure and property-tested. An offer, counter or accept is refused unless it is inside the **sender's own** bounds (buyer: price <= mandate maximum, lead time <= maximum, quantity = mandated quantity; seller: price >= effective floor, lead time >= price book lead time, quantity within MOQ and capacity). It does not matter who sent it: internal agent, external agent or person. |
| No leaking of limits | Violation text names only the sender's own limit and contains no numbers. Views return only the requester's own limits (`yourLimits`). The counterparty and the admin app never receive either side's floor, ceiling or auto-accept limit. The private snapshots (`buyerPrivate`, `sellerPrivate`) are never selected into any view. |
| Human confirmation | See below. No code path creates a Quote or Order except `finalise()`, reached only after both confirmations are `human` or `auto`. |
| Every action visible | `AgentActivity` (append-only, same transaction as the state change) is shown as "What my agent did", with `byAgent` true when no person was involved. |
| Safety | Suspension (mandate, business, API key), per-business and per-key rate limits, anomaly flags (below). |
| Money | Integer paise (`BigInt` columns; JSON carries safe integers). |

## Data model

- `AgentMandate`: side, status (`active | paused | revoked | expired | completed | suspended`), category, `spec` (buyer: title, requirement, delivery city/pincode, delivery and payment terms), quantity, unit, `targetPricePaise`, `limitPricePaise` (buyer maximum / seller private floor), `maxLeadTimeDays`, seller `maxDiscountPct`, `capacityQty`, `priceBookId`, buyer `approvedSellerIds`, `maxRounds`, recurrence (`recurrenceDays`, `nextRunAt`, `lastRunAt`), `expiresAt`, `autoAccept`, `autoAcceptLimitPaise`, consent timestamps, `version`.
- `AgentMandateChange`: append-only audit of every change (`action`, `actorKind` human | system | admin | api, snapshot).
- `AgentRun`: one scheduled run, unique on (mandate, `runKey` = scheduled time). A retried tick can never post a second enquiry.
- `AgentNegotiation`: buyer/seller business and mandate, `enquiryId`, `matchId` (unique: one negotiation per match), per-side driver (`internal | external`), `initiatedBy`, status (`open | agreed | accepted | rejected | withdrawn | expired`), `round`, `maxRounds`, `turn`, private snapshots, `lastOffer`, `agreedTerms`, per-side confirmation (`pending | human | auto | declined`), `quoteId`, `orderId`, `realiseError`, `flagged`, `expiresAt`.
- `AgentMessage`: the transcript: `seq`, side, type, `pricePaise`, `quantity`, `terms` JSON (unit, lead time, delivery terms, validity, payment terms), `idempotencyKey` (unique per negotiation and side), `actorKind` (internal_agent | external_agent | human), `apiKeyId`.
- `AgentActivity`, `AgentSuspension`, `AgentAnomaly` as described in the guardrails.
- No Prisma relations to foreign models; `check:boundaries` passes.

## Protocol

Message types: `offer` (opening only), `counter` (answers the other side's standing offer), `accept`, `reject`, `withdraw`. An offer is typed terms: `pricePaise`, `quantity`, `unit`, `leadTimeDays`, `deliveryTerms`, `validUntil`, `paymentTerms`. Accept always refers to the other side's standing offer (terms cannot be altered in the accept).

```
            offer/counter (in bounds, no retreat, round <= max)
open  ------------------------------------------------------>  open (turn flips)
open  --accept (acceptor's bounds + validity re-checked)---->  agreed
open  --reject-->  rejected        open --withdraw (either side)--> withdrawn
open | agreed  --deadline-->  expired
agreed --both principals confirm (human or auto within bounds)--> accepted (Quote + Order exist)
agreed --a principal declines--> rejected
```

Rules in `step()`: turn order; `offer` only when nothing is standing; you cannot answer your own offer; at most `maxRounds` price messages (the last one can only be accepted, rejected or withdrawn); a buyer never lowers its own previous price and a seller never raises its own; `validUntil` within today and 90 days; nothing is accepted after the negotiation deadline (`A2A_NEGOTIATION_TTL_HOURS`, default 24). Every message carries an idempotency key; a retry returns the original result without a second message.

## Human confirmation and the real deal

On `accept`, `AgentNegotiation.agreedTerms` is fixed and each side's confirmation is computed: `auto` only when that side enabled auto-accept AND the terms are inside its auto-accept limit and its hard bounds; otherwise `pending`. The principal sees it under "Needs your confirmation" (window `A2A_CONFIRM_TTL_HOURS`, default 48) and confirms or declines; a decline closes the negotiation as `rejected`. When both sides are `human` or `auto`, `finalise()` (advisory-locked, idempotent, resumable):

1. seller side: if the match is still `offered`, `enquiry.acceptLead` as the seller (this is the credit spend; it happens only because the seller confirmed or explicitly enabled auto-accept);
2. `enquiry.sendQuote` as the seller with the agreed price, quantity, unit, lead time and validity; delivery and payment terms go into the quote notes with a `[a2a:<negotiationId>]` marker so a crashed attempt is recognised and never duplicated;
3. `enquiry.recordOrderFromDeal` as the buyer (one order per match), then `confirmOrder` for both sides;
4. the negotiation becomes `accepted` and `AgentNegotiationClosed` is emitted with `confirmedBy` = `auto` (both sides auto) or `human`.

A failure (for example the seller has no credits) leaves the negotiation `agreed` with `realiseError` and a Retry action for either principal. A lead that is no longer available closes it as `expired`. Nothing is ever half-recorded as accepted.

## Internal agents

- `runDueMandates` (worker job, every minute, flag on): a recurring buyer mandate posts an enquiry as the buyer through `enquiry.createEnquiry` (same moderation, intent scoring and matching as a person), then for each offered match whose seller has a compatible active quoting mandate (and is on the approved list when one is set) it calls `startNegotiation`. Sellers without an agent are untouched: their lead follows the normal human quote flow (ADR-014 quote-assist still applies). A failing run is logged (`run_failed`) and the schedule still advances.
- `advanceNegotiation` (queue `a2a.advance`, plus a sweep every minute for lost jobs): when it is an internal agent's turn it computes a deterministic move and sends it through the same `sendNegotiationMessage` path as everyone else. Buyer agent: opens at the target (else 80% of its maximum), concedes half the gap each round, accepts when the seller is within 2% of its last offer or on the final round if the terms fit. Seller agent: opens at the price-book tier price, concedes half the gap towards the buyer, never below the effective floor (max of price-book floor, mandate floor and the max-discount floor), same acceptance rule. `guarded()` makes an agent withdraw rather than emit an offer the server would refuse (for example an unsatisfiable mandate). No model is called: the ADR-008 rule is satisfied vacuously, and a model-backed strategy would have to go through `@cnote/ai` and pass the same bounds.
- A mandate that is paused makes its agent wait; revoked, expired or suspended mandates withdraw their negotiations.

## External agent API

`/v1/agents/*` and the MCP tools (`docs/api/agents.md`). Scopes `agents:read`, `agents:write` (business-bound). A key acts only as its business, only inside a mandate people created, and can never confirm. The first external message on a side flips that side's driver to `external` ("take over"), so the internal agent stops acting for it.

## Safety

- Suspension: `suspend({kind: mandate | business | api_key})` by staff (`agents.suspend`, audited in the admin app). A mandate suspension sets status `suspended`, turns auto-accept off and withdraws its open negotiations; a business suspension blocks every send against and from it; a key suspension blocks that key. Lifting returns a mandate to `paused` (the owner resumes).
- Rate limits (Redis fixed window): per business `A2A_BUSINESS_MSGS_PER_MIN` (120), per key `A2A_KEY_MSGS_PER_MIN` (60), negotiations started per business per hour `A2A_STARTS_PER_HOUR` (30). Internal agents are exempt from the key limit only.
- Anomalies (`AgentAnomaly`, flags not verdicts, shown to the principal and in the admin console): the 3rd identical message within 60 seconds flags `rapid_identical_offers` and the 6th is refused; the 5th out-of-bounds attempt in 10 minutes flags `repeated_out_of_bounds`.

## Metrics (`a2aMetrics`)

`agentClosedDeals`, `autoAcceptShare` (accepted deals where both sides auto-confirmed) and `anyAutoShare`, `medianRoundsToClose` / `meanRoundsToClose`, `humanOverrideRate` = agreed-by-agents negotiations a person declined or let lapse / all agreed-by-agents, `externalShare`, `flagged`. Events for the metrics package: `AgentMandateCreated`, `AgentNegotiationStarted`, `AgentOfferMade`, `AgentNegotiationClosed`.

## Configuration

`A2A_ENABLED=true|1|yes`, `A2A_NEGOTIATION_TTL_HOURS` (24), `A2A_CONFIRM_TTL_HOURS` (48), `A2A_BUSINESS_MSGS_PER_MIN` (120), `A2A_KEY_MSGS_PER_MIN` (60), `A2A_STARTS_PER_HOUR` (30). Mandate pages work while the flag is off and show a notice; agents do nothing.

## Known gaps

- `enquiry.acceptLead` takes an `Actor` only: there is no way to mark the credit spend as agent-initiated, so the wallet shows a normal lead accept.
- Closed: the agreed offer's free-text delivery/payment terms are mapped onto the structured `Quote` fields (unrecognised text becomes `other` + note); the `[a2a:<id>]` notes marker is no longer written (old markers are still recognised), and a quote sent but not yet linked is recovered by matching the seller's own quote for that match (`listSellerQuotes`). `getQuote` validates the stored `quoteId`.
- The enquiry public API now has `getSellerLead` (seller-side match read) and `getBuyerEnquiry` (matches); no separate "matches for enquiry" function was added.
- Notification templates for "needs your confirmation", "agreed" and "suspended" are not registered: the in-app lists and activity log are the surface today. Wire the `Agent*` events into `@cnote/notifications` when its templates are added.
- The seller quoting strategy is price-only (quantity is clamped, lead time never below the price book). Multi-listing bundles, freight negotiation and payment-term trade-offs are not modelled.
- Golden-set evals do not apply (no model in the loop); add them when a model-backed strategy is introduced (ADR-008).
- The seller mandate's capacity is a per-negotiation cap, not a running inventory.
- Confirmation acts as the mandate owner's person id for `enquiry` calls (`createdByPersonId`); `enquiry` only checks business participation.

## UI and Mobbin references

Consulted before designing (Mobbin, web). Principle across all three surfaces: the agent is a delegate with visible limits, auto-accept is a separate, off-by-default permission, pause is the easy path and revoke is the deliberate one, and a deal is never "done" until the human presses Confirm.

Seller (`apps/seller`, routes `(portal)/agents`, `features/a2a`):

- Auto-accept as its own permission, one click to disable: [Emergent "Disabling an auto-approve"](https://mobbin.com/flows/a4facd5e-16d7-4dd5-812b-e17e46e3abc2). Adopted the dedicated panel, off by default. Changed: enabling needs a consent tick and a price limit.
- Pause as a first-class control with an inline change trail: [ManyChat "Pausing an automation"](https://mobbin.com/flows/2a0c1fca-babc-4685-baf0-1e70b71cb11e). Used for pause/resume and mandate change history.
- Mandate list rows: [Mintlify automations list](https://mobbin.com/screens/083228c0-0ebd-4c79-9517-6a01287e02e9). Changed: a status badge instead of a toggle, because revoke is irreversible.
- "Needs your confirmation" list with a count: [ClickUp Timesheet Approvals](https://mobbin.com/screens/72d64728-a1bb-4767-929c-fe34a6907c80).
- Typed transcript, one row per round: [Aboard Approvals table](https://mobbin.com/screens/2d7a7bf0-9c57-4f9f-8919-354d044f7660).
- Confirm beside a secondary decline next to the details: [Toggl Track timesheet approval](https://mobbin.com/screens/79c40b97-ee41-4051-ac7f-f24ea8a9cdfb).

Buyer web (`apps/web`, `/buyer/agents`, WCAG 2.2 AA):

- "When ... then ... needs approval" framing and per-rule status: [Contractbook "Creating an automation"](https://mobbin.com/flows/34ac95e3-8090-4b17-bd32-2a4b81144f4b). Not adopted: the canvas builder (not accessible enough).
- Summary with Approve/Reject at the bottom: [Airwallex spend request approval](https://mobbin.com/screens/f13414b4-443f-4484-bd3a-4b5970db2cc3) became Confirm deal / Decline.
- Mandate card with status, next run and an enabled state as text: [Deel automatic payments](https://mobbin.com/screens/dc11fd6c-f9d3-4645-8c29-a34d89a88717).
- Recurrence choice: [Walmart "Setting up a subscription"](https://mobbin.com/flows/53cd51e4-a316-4fd4-a113-4b9fb55f2f80). Changed: a free number of days instead of presets.
- Pause instead of cancel: [Juicebox subscription pause](https://mobbin.com/screens/336e3926-76dc-454c-83ef-e06b6428e016), with Revoke behind an inline warning step.
- Explicit confirm for consequential actions: [Xero bulk confirm dialog](https://mobbin.com/screens/e2860d2e-4007-4f92-a1a5-d7427ad15d0b). Bulk approve deliberately dropped: every deal is confirmed individually.
- a11y: transcript and history are real tables (caption, scope headers) in focusable scroll regions; errors in `role="alert"` with a focused summary; outcomes in an always-mounted `aria-live` region; 44px targets; statuses are text, never colour alone; money parsed with integer math on strings (no float drift). Forms submit through `onSubmit` so a failed submit does not wipe input (they need JavaScript).

Admin (`apps/admin`, `(console)/agents`):

- Reason column and filter over suspended items: [Klaviyo suppressed profiles](https://mobbin.com/screens/c6b24290-fa14-4f71-a887-2ceda46e304f) (Active suspensions table).
- Filter bar over actor/action/time: [Klaviyo activity log](https://mobbin.com/screens/1f44450b-8a6f-4d19-83e8-24addf2ca0e8) (negotiations and anomalies tables).
- Confirmation step for an irreversible bulk action: [Sweatpals confirmation dialog](https://mobbin.com/screens/0e833b91-9279-4b10-9500-0245f055a02e) (suspend / lift).
- Chronological "who did what": [Basecamp history of changes](https://mobbin.com/screens/07446502-ce66-4714-a13d-fd4d6b9707a9) (transcript rows).

Messages: `apps/seller/messages/<locale>.a2a.json` and `apps/web/messages/<locale>.a2a.json` for en, hi, kn, ta, te, mr, gu, bn (top-level key `a2a`, identical keys and placeholders; the seven non-English files are machine-drafted and flagged `_meta.review`). The admin console is English only.
