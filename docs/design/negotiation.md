# Negotiation assist (ADR-014)

Package `@cnote/negotiation`, schema `packages/db/prisma/schema/negotiation.prisma`, AI capabilities `packages/ai/src/quotes.ts`. Feature flag `QUOTE_ASSIST_ENABLED` (default off).

Two assists on the existing manual quote flow (enquiry: `sendQuote`, `sendMessage`), no change to `@cnote/enquiry`:

1. **Seller quote-assist.** When a seller accepts a lead, the agent drafts a quote from the structured RFQ, the seller's price book and their quote history. The seller approves, edits or discards it in the app (or approves on WhatsApp). Approval calls `enquiry.sendQuote` as the seller.
2. **Buyer comparison and counter assist.** Quotes received on an enquiry are normalised into a like-for-like table (delivered price per unit, lead time, validity, seller trust tier). Within buyer-set bounds the agent proposes a counter that the buyer edits and sends explicitly as a chat message.

Full agent-to-agent negotiation stays with ADR-020.

## Guardrails (non-negotiable, ADR-014)

| Rule | How it is enforced |
| --- | --- |
| Agents never commit either party | A `QuoteDraft` is inert. The only path to a real `Quote` is `approveDraft` (seller actor, atomic claim `pending -> approved`, then `enquiry.sendQuote`; a failed send rolls the claim back). A `CounterProposal` is inert; `sendCounterOffer` (buyer actor, atomic claim) is the only thing that contacts the seller. No code path sends on a timer or from an event handler. |
| Every action is logged and visible | `AgentActionLog` (append-only, written in the same transaction as the state change). Shown to the principal as "What the assistant did" (seller: price book page and the conversation page; buyer: the enquiry page). Each row says whether the assistant acted alone or a person confirmed. |
| Price bounds enforced server-side | `bounds.ts` is pure and property-tested. Model output is treated as a suggestion. Seller side: price must be >= the private floor (checked at generation and again at approval against the current floor). Buyer side: a counter must be below the quote, <= the buyer's maximum, >= 50% of the quote, and any lead-time ask <= the buyer's limit; checked at proposal and again at send. A proposal outside bounds is discarded (logged as `draft_bounds_rejected` / `counter_bounds_rejected`) and replaced with a deterministic in-bounds value, or nothing is proposed when none exists. |
| Money | Integer paise (`BigInt` columns). Tier breaks are JSON of integer paise. |

## Data model

- `SellerPriceBook` per (seller, listing): base price, volume tiers, **private floor**, MOQ, lead time days, delivery terms, GST %, GST included, validity days, active. Seeded from the live listing price through catalogue's public API; the floor defaults to the base price (the agent never discounts until the seller says how far it may go). Editing sets `seeded = false`; re-seeding never overwrites an entry.
- `QuoteDraft` (unique per match): price, quantity, unit, MOQ, lead time, shipping terms, valid until, notes, rationale, confidence, `needsReview`, `boundsCheck`, the draft as generated (`original`), decision id, outcome (`quoteId`, `edited`, `editedFields`, `priceDeltaPct`, `notesEditDistance`, who/where decided).
- `BuyerBounds` per enquiry: target, ceiling (maximum), longest delivery time. The RFQ's own target price seeds the target until the buyer sets bounds.
- `QuoteTerms` per quote: delivery charge / included, GST %, GST included, payment terms, extracted once by the normaliser (one logged AI decision), then reused.
- `CounterProposal`: quoted price, proposed price, lead time ask, note, rationale, status `proposed | sent | discarded`.
- `AgentActionLog`, `LeadQuoteTiming` (accepted-at, first-quote-at, assisted flag; feeds the time-to-first-quote metric and is written even while the flag is off so a "before" baseline exists).

## Flow

```
LeadAccepted --(worker, flag on)--> queue negotiation.draft_quote --> generateDraft
   generateDraft: getSellerLead -> selectPriceBookForRfq -> ai.draftQuote -> server bounds check
                  -> QuoteDraft + QuoteDraftGenerated + AgentActionLog (one tx)
seller: approve (edits optional) -> bounds re-check vs current floor -> enquiry.sendQuote -> QuoteDraftApproved (edited flag)
QuoteSent --(worker)--> LeadQuoteTiming.firstQuoteAt

buyer: compareQuotes -> ai.normaliseQuotes (missing quotes only) -> landed price per unit, best value / lowest / fastest
buyer: set bounds -> proposeCounterOffer -> ai.proposeCounter -> server bounds check -> CounterProposal (nothing sent)
buyer: edit + sendCounterOffer -> bounds re-check -> enquiry.sendMessage -> CounterOfferProposed
```

Draft selection: the RFQ has no listing id, so the agent picks an active price book entry whose listing is in the RFQ's category, best title/description word overlap first (ties to the most recently updated listing). With no fit it drafts nothing and logs `draft_failed` ("add it to your price book or quote manually").

Landed price per unit = quoted price + delivery charge / quantity, then x (1 + GST %) when GST is stated as extra. Unknown delivery or GST are flagged ("Incomplete: GST not stated, so the real cost may be higher"), never guessed. Best value = weighted min-max score (price 60, lead time 25, verification tier 15); expired quotes never win. The message body of a counter is built server-side (buyer's editable note + an exact "Counter-offer: Rs X per unit (your quote: Rs Y)" line) so an edited note can never disagree with the price.

## AI (ADR-008)

Capabilities `draftQuote`, `normaliseQuotes`, `proposeCounter` in `packages/ai/src/quotes.ts`: typed input/output, provider registry (`getQuoteProviders`, `AI_PROVIDER=heuristic` default and deterministic for CI; `anthropic` with heuristic fallback on any failure, structured JSON output, untrusted input fenced in `<user_input>`), an `AiDecision` row per call (prompt version, model id, redacted input, output, confidence, latency), review thresholds in `QUOTE_REVIEW_THRESHOLDS` (0.6 / 0.5 / 0.55). Low confidence sets `needsReview` and the UI says "Check this carefully". Unlike scoring capabilities no ops `ReviewItem` is created: the seller or buyer is the human reviewer of every output, and an ops queue entry per draft would only add noise. Golden-set eval gating for the new prompts is not built yet (the existing harness in `packages/ai/evals` covers intent/extract/moderate).

The seller's floor is sent to the model in the draft prompt so it does not waste a proposal below it. It is business data, not personal data; PII in free text (RFQ requirement, quote notes) is redacted with the existing `redactDeep` before any vendor call and before audit logging.

## UI and Mobbin references

Consulted before designing (Mobbin, web):

- Comparison layout: [Fiverr package comparison](https://mobbin.com/screens/6a302bde-9823-478b-bbbc-ff95786fb3bc), [Synthesia compare plans](https://mobbin.com/screens/28175899-b402-4c29-970f-18234411d48c) and [Asana "Recommended" column](https://mobbin.com/screens/5c6d27f8-ff4f-47da-a25c-bb448c5e1129). Adopted: one row per option with aligned attributes and a single highlighted recommendation. Changed: highlight by a text badge ("Best value", "Lowest price", "Fastest"), never colour alone, and sellers as rows (a real `<table>` in a keyboard-focusable scroll region) so it works at 320px.
- AI draft with approve / edit / discard: [Notion Mail inline "Accept / Discard / Try again"](https://mobbin.com/screens/c76eb3bd-f70d-4235-baf4-f24c06421205), [ClickUp "review or edit before I send"](https://mobbin.com/screens/0ca0b550-c8f4-47eb-8d52-059738f8db48), [Rox draft email preview](https://mobbin.com/screens/3d205a5d-5ead-4787-af2c-9b0a36ed2fc7). Adopted: the draft is fully editable in place with two explicit actions (Approve and send / Discard) and a permanent line "Nothing has been sent". Changed: no "try again" (a second model call adds no trust; the seller edits or quotes manually).
- Counter-offer: [Etsy "Make an offer"](https://mobbin.com/flows/7ff8b078-bf25-4f3c-95cc-2503bcf1eb0a) and [Depop "Sending an offer"](https://mobbin.com/flows/c8e7403c-c409-45d6-8279-467a92223844). Adopted: price field with the current price beside it, and the reminder that an offer is not a purchase (here: "Nothing has been sent" until Send). Changed: the suggested number comes from the buyer's own bounds with a plain-language reason, not fixed percentage chips.

Surfaces:

- Seller portal `/price-book` (new page): one card per listing, private floor labelled as private, "Copied from your listing: review it" until edited, plus the assistant log.
- Seller conversation page: `QuoteAssistPanel` (one mount line) above the manual quote form; the manual form always remains.
- Buyer enquiry page: `NegotiationAssist` (one mount line). Strings: `apps/web/messages/<locale>.negotiation.json` for en, hi, kn, ta, te, mr, gu, bn with identical keys (namespace `negotiation`, already registered); non-English files are machine-drafted and need native review. The seller app is English-only like the rest of the portal.
- WCAG 2.2 AA (buyer): labelled controls with hints via `aria-describedby`, errors in `role="alert"`, results in `role="status"`, table caption and `scope` headers, 44px targets, focusable scroll region, text badges.

## Metrics (`draftMetrics`, `timeToFirstQuote`)

- Draft acceptance rate = approved / (approved + discarded); unedited rate; mean fields changed (of 7), mean absolute price change %, mean notes Levenshtein distance among approved drafts; bounds rejections; low-confidence count.
- Time to first quote: LeadAccepted to first QuoteSent, median / mean / p90 for `assisted` (first quote came from an approved draft) vs `manual`, and `medianSavedMs`. Because timing rows are written whether or not the flag is on, "before" is the manual cohort up to the flag-on date and "after" the assisted cohort; pass `from` / `to` to split at the rollout date.

## Configuration

`QUOTE_ASSIST_ENABLED=true|1|yes` enables drafting, the buyer assist and the seller panel. Price book pages work regardless. `AI_PROVIDER`, `AI_MODEL_REASONING` as for the other capabilities.

## Known gaps

- Closed: `Quote` now has optional structured terms (MOQ, delivery terms + charge, payment terms, GST included), `sendQuote` returns `{ quoteId }`, and enquiry exposes `getQuote` / `listSellerQuotes`. Approved drafts send shipping/MOQ/GST as fields; the comparison reads structured terms and only falls back to notes extraction for older quotes. `deliveryChargePaise` is the total for the quoted quantity.
- Structured delivery/payment terms are enum-ish strings (`ex_works|fob|door_delivery|buyer_pickup|other`; `advance|on_delivery|net_7|net_15|net_30|escrow|other`) plus a free-text note; a door delivery with no stated charge stays "unknown" in the landed price (never guessed).
- The seller/buyer bounds compare the quoted per-unit price (before freight and GST), not the landed price.
- Server-action error text (DomainError messages) is English.
- WhatsApp approval: `approveDraftFromChannel(draftId, sellerPersonId, decision)` is exported; wiring a template/button in `@cnote/whatsapp` is not done here.

## Structured quote terms: Mobbin references

Consulted before changing the seller quote form (Mobbin, web): [Zoho CRM "Create Quote"](https://mobbin.com/screens/b3a32722-ca59-45b8-aea2-0eedb7e29231) keeps a separate "Terms and Conditions" block under the line items (adopted: core price/quantity fields stay on top, terms sit in their own block); [Etsy "Pricing & Shipping"](https://mobbin.com/screens/58e1b5e4-ce74-42e2-b402-aeb880b1b163) groups shipping inputs in one section (adopted the grouping); [Xero "New Bill"](https://mobbin.com/screens/77bd911b-7f1a-4ebb-9351-c5b8671548ec) hides secondary detail behind small controls (adopted a collapsed disclosure so the form stays compact on mobile). Changed: terms are a native `<details>` (keyboard operable) and every field is optional.
