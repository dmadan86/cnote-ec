# Disputes (ADR-013): AI-mediated resolution with human adjudication

Package `@cnote/disputes` (flag `DISPUTES_ENABLED`, default off). Schema: `packages/db/prisma/schema/disputes.prisma`. AI: `briefDispute` in `packages/ai/src/disputes.ts`.

## Principles
- The module never moves money. It emits `DisputeOpened`, `DisputeEscalated`, `DisputeResolved` (+ `DisputeBriefReady`); escrow (ADR-012) freezes on open and refunds/releases on resolve.
- The AI is advisory. Nothing is decided by a model except clear, low-value, high-confidence cases of an allow-listed type, and even those wait out a 48h window in which either party can escalate to a person.
- Evidence is personal data (ADR-010): PII is redacted before any model call and in the audit row, files sit in the PRIVATE bucket, and a retention purge removes content while keeping decisions.

## Flow
1. **Intake** (buyer or seller of the order, via enquiry `getOrder`): structured form (type, description, claimed amount, photos, PDFs, a voice note in any language). Voice needs explicit consent and is transcribed with `@cnote/ai transcribe`; a voice-only report uses the transcript as its description. One active dispute per order (unique `activeOrderId`, released on close). Claim cannot exceed order value. Amount at stake = escrow held, else order total.
2. **Evidence collection** (queue `disputes.collect`, idempotent by `sourceRef`): order facts (incl. dispatch/delivery lifecycle), quotes, conversation transcript (via enquiry public functions only), escrow status and GST invoice (via `EscrowPort`), quality checks (via `QualityEvidencePort`, advisory per ADR-015).
3. **Response window**: counterparty has `DISPUTES_RESPONSE_HOURS` (72). A written/voice response closes the window early. Either side can add evidence until the brief starts.
4. **Brief** (queue `disputes.brief`): classify, summarise, check the claim against agreed specs, recommend an outcome with refund/release split, confidence and cited evidence ids. Emits `DisputeBriefReady`. Provider errors retry with backoff then dead-letter; `advance` re-enqueues stalled work.
5. **Routing**: `routeBrief` (pure). Auto-proposal only if type in `DISPUTES_AUTO_TYPES`, amount <= `DISPUTES_AUTO_MAX_PAISE`, confidence >= `DISPUTES_AUTO_MIN_CONFIDENCE`, the outcome is not a split and the AI did not flag it for review. Otherwise `awaiting_adjudication`.
6. **Resolution**: an adjudicator (admin, `disputes.adjudicate`, audited) accepts or modifies the recommendation (refund + release must equal the held amount). Auto proposals apply when the escalation window closes. `DisputeResolved` carries `refundPaise`, `releasePaise`, `faultBusinessId`, `decidedBy`.
7. **Outcome feedback**: an `AiDecision` labelled example (`dispute_outcome_label`: recommendation vs final, agreed, fault role) feeds evals and the fraud classifiers. Identity observes `DisputeResolved` to adjust trust (ADR-003).
8. **Appeal**: either party, once, within 7 days of a decision (not for withdrawn). Second review by staff; upheld or modified. Appeals do not re-emit `DisputeResolved`.
9. **SLA**: due 7 days after opening; `advance` job flags overdue cases; `disputeMetrics` gives median time to resolution vs the 7 day target, share within SLA, auto share, appeal rate, brief agreement rate. Admin queue sorts by soonest deadline.

## State machine
`open -> evidence -> brief_ready -> (auto_resolved | awaiting_adjudication) -> resolved | withdrawn`. `auto_resolved` is a *proposal* pending the escalation window; escalation moves it to `awaiting_adjudication`. `brief_ready` is transient inside the brief transaction. Withdrawal by the opener is allowed from any active state and emits `DisputeResolved(outcome: withdrawn, 0, 0)` so escrow resumes its normal flow.

## AI capability (`briefDispute`, ADR-008)
Typed input/output, provider-agnostic. `AI_PROVIDER=heuristic` (default, CI): deterministic rules over English, Hinglish and Devanagari keywords, order/quote comparison, received-count extraction, quality-check verdicts, seller admissions and proof-of-delivery claims; confidence rises with independent corroboration and falls with conflicts (max 0.95). `anthropic`: structured JSON output, untrusted-input guard in the prompt, redacted payload, citations restricted to real evidence ids, amounts recomputed server-side, heuristic fallback on any failure. Every call writes an `AiDecision` (capability `dispute_brief`, redacted input, model id, prompt version) and a `ReviewItem` below confidence 0.6. Prompt/model changes must pass the golden-set evals (labelled outcomes above are the raw material).

## Screens and Mobbin references
Consulted Mobbin before designing:
- Etsy "Submit a help request" (radio list of issue types, resolution preference, free-text details, one primary button): adopted for the buyer report form (issue radio group, details, amount, evidence).
- Whop resolution-case activity feed with explicit deadlines ("Respond within 7 days, otherwise ... will review"): adopted for the response-window alert and the evidence/activity list on the detail pages.
- Airbnb "Refund status" stepper and Selfridges numbered stepper with "Timeframe": adopted for status badge plus due-by copy and the five-step policy page.
- Binance "Report a merchant" (reason list, 500 char details, upload proof with limits): adopted for evidence upload hints and limits.
- Fiverr "Resolution Center" (order summary card beside the actions): adopted for placing the report entry on the order page.

Buyer web (WCAG 2.2 AA): native `<details>` disclosure on the order page, `fieldset/legend` radio group, every control labelled, errors in `role="alert"`, 44px targets, no colour-only status (badge text). Localised policy page `/dispute-policy` and namespace `disputes` in all 8 locales. Seller: `/disputes` list and detail with respond/evidence/escalate/appeal. Admin: `/disputes` queue with SLA and metrics, detail with AI brief (spec-check table, cited evidence highlighted, late-evidence warning), evidence viewer (private routes, no-store), decision form (audited), appeal form, per-party message threads.

## Configuration
`DISPUTES_ENABLED`, `DISPUTES_AUTO_MAX_PAISE` (500000), `DISPUTES_AUTO_MIN_CONFIDENCE` (0.85), `DISPUTES_AUTO_TYPES` (quantity_short,damaged,wrong_item), `DISPUTES_RESPONSE_HOURS` (72), `DISPUTES_ESCALATION_HOURS` (48). Constants: SLA 7 days, appeal window 7 days, evidence retention 1095 days.

## Open legal items
- Policy wording and the auto-resolution consent model need legal review; auto-decisions on money movement may need explicit acceptance in the seller and buyer terms.
- Retention period for evidence (set to 3 years, the limitation period, unconfirmed) and whether decisions/briefs may be kept longer.
- Effect of an appeal that modifies an outcome after escrow payout (currently recorded only; finance settles). Needs a policy for clawback or platform-funded goodwill.
- Consent text for voice notes (DPDP purpose limitation) and cross-border processing if a non-India model region is ever used for briefs.
- Whether adjudicator decisions are binding or only a platform-level resolution that leaves the right to approach courts/consumer forums intact (state this in the policy).
- Adjudicator conflict-of-interest and audit requirements (four-eyes above a threshold?).
