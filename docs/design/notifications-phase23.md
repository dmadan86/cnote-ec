# Notifications for Phase 2/3 events

Status: implemented in `@cnote/notifications` (kinds in `src/kinds-phase23.ts`, copy in `src/copy-phase23.ts`).
Follows the existing observer pipeline (ADR-007): domain event -> kind -> recipients (per person) -> preference gate ->
`Notification` row (unique per person, kind, event) -> `notification.deliver` jobs for email/WhatsApp/SMS. Nothing here is
marketing; no consent gating beyond the normal per-category preferences.

## Kinds

| Kind | Event | Recipients | App | Category |
|---|---|---|---|---|
| ads.campaign_approved / ads.campaign_rejected | AdCampaignReviewed | seller members | seller | billing |
| ads.campaign_paused_wallet / ads.campaign_paused_eligibility | AdCampaignStatusChanged (cause wallet / eligibility, not resumed) | seller members | seller | billing |
| ads.campaign_suspended | AdCampaignStatusChanged (cause staff, to suspended) | seller members | seller | billing |
| ads.budget_exhausted | AdBudgetExhausted (replaces a budget-cause halt notice) | seller members | seller | billing |
| ads.wallet_low | AdWalletLow | business owners | seller | billing |
| a2a.confirmation_needed | AgentNegotiationClosed (accepted, confirmedBy null) | businesses still to confirm | web + seller | messages |
| a2a.agreed_auto | AgentNegotiationClosed (accepted, confirmedBy auto) | both | web + seller | messages |
| a2a.ended | AgentNegotiationClosed (rejected / expired) | both | web + seller | messages |
| a2a.offer_awaiting | AgentOfferMade (only if a human must reply) | that principal | web or seller | messages |
| escrow.funded | EscrowFunded | seller | seller | billing |
| escrow.released / escrow.payout_settled | EscrowReleased / PayoutSettled | seller | seller | billing |
| escrow.refunded | EscrowRefunded | buyer | web | billing |
| escrow.frozen | EscrowFrozen | buyer + seller | web + seller | billing |
| dispute.opened | DisputeOpened | against-business | web or seller | messages |
| dispute.brief_ready | DisputeBriefReady | both | web + seller | messages |
| dispute.resolved | DisputeResolved | both | web + seller | messages |
| credit.offer_received / disbursed / overdue / closed / cancelled | CreditOfferReceived / Disbursed / Overdue / Closed / Cancelled | business owners | seller | billing |
| quality.check_completed | QualityCheckCompleted | seller members | seller | listings |
| ondc.order_received / ondc.issue_received | OndcOrderReceived / OndcIssueReceived | seller members | seller | leads |
| negotiation.draft_ready | QuoteDraftGenerated | seller members | seller | leads |
| order.fulfilment_updated | OrderFulfilmentUpdated | buyer members | web | messages |

Categories reuse the existing seven (descriptions in `preferences.ts` were widened). Defaults therefore follow the
existing matrix: in-app on; email on for billing/messages/leads and off for listings; WhatsApp/SMS off until the person
opts in and staff publish a `whatsapp`/`sms` template for the key (same rule as every existing kind; no channel default
templates were added, because the existing kinds have none either).

## Privacy (ADR-010)

Copy is language-neutral and never names the counterparty. Money is formatted in rupees with Indian grouping. Not sent:
dispute fault, AI recommendation/confidence, quality verdict, reviewer identity. Credit notices go to owners only.
Money and credit amounts come from the event payload.

## Recipient lookups the events do not carry

Several events name an order/application/negotiation id but not the parties. `@cnote/notifications` may not query other
modules' tables and the owning modules export no actor-free getter, so `Directory` gained four OPTIONAL lookups
(`orderParties`, `ondcOrderSeller`, `creditApplicationBusiness`, `negotiationParties`) backed by
`setPartyResolvers()`. Until the worker wires them the affected kinds resolve no recipients (silent, never wrong):
escrow.funded, escrow.frozen, dispute.brief_ready, dispute.resolved, ondc.issue_received, credit.offer_received and
all a2a kinds. Wire once at worker start, using functions of the owning modules (an order getter in `@cnote/enquiry`,
a negotiation getter in `@cnote/a2a`, application/loan owner in `@cnote/credit`, ONDC order in `@cnote/ondc`). Preferred
long-term fix: add the party ids to those event payloads (version bump per ADR-007) and delete the resolver.

## Locales

`TemplateDefinition.localized` (new, in `@cnote/templates`) seeds per-locale rows next to `en` and is the code fallback
for that locale. Hindi is team-written; kn, ta, te, mr, gu, bn are machine-drafted and seeded with a "NEEDS REVIEW"
change note. In-app copy exists for all 8 locales, email for en and hi. The pipeline does not yet pass a locale to the
renderer (no person locale exists in identity), so non-English rows are used once that is wired.

## Gaps

- No event for agent mandate suspension (`a2a.suspend()` emits nothing): needs a `AgentMandateSuspended` event, then a kind.
- DisputeBriefReady does not say who owes a response; both parties get a neutral notice.
- AdCampaignStatusChanged fires no notice for cause budget (covered by AdBudgetExhausted) or seller actions.
- EscrowUnfrozen, EscrowMilestoneReached, CreditRepaid, DisputeEscalated are intentionally not notified.
