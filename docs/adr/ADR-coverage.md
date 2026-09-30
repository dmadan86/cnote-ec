# ADR coverage: what the code implements against ADR-000 to ADR-025

**As of:** 30 Sep 2026, wave 5 (see "Wave 5 update"); wave-4 notes refer to HEAD `425e151` (wave 4: metrics, orders, boundary guard, Hindi UI, photo/voice listings, WhatsApp channel, DPDP compliance). A "Wave 4 update" note under each affected ADR supersedes the older gap text above it.
**Method:** read `docs/adr/ADR-v0.1.md`, `ADR-024-025-proposed.md`, every `docs/design/*.md`, the package sources, the Prisma schemas and the event catalogue; then judged each ADR by what is actually in code. Evidence lists packages and files; gaps are stated against the ADR text.

## Wave 5 update (supersedes gap text below where it overlaps)

- **ADR-001/005 payments + GST invoicing:** `PaymentOrder` via a payment-gateway port (mock by default; Razorpay adapter), signed idempotent webhooks (`apps/api`), GST invoices with gap-free per-FY sequences stored in the private media bucket, refunds, pricing CTAs to hosted checkout; paid plans chosen at onboarding go to checkout (never activated without payment).
- **ADR-002 reachability:** automated buyer reachability check after a lead is accepted (WhatsApp utility template → SMS fallback, delivered from the worker via the `enquiry.reachability_dispatch` queue); unreachable buyers feed the 72h auto-refund.
- **ADR-003 T2 KYC:** document KYC sessions (private `kyc/` keys, VLM extraction with masked PAN/Aadhaar, staff review, 90-day document retention) and periodic verification audits; upheld "offer not honoured" reports now lower the trust score.
- **ADR-004 languages:** buyer web in 8 locales (en, hi, kn, ta, te, mr, gu, bn) with a key-parity test. Seller-app i18n still open.
- **ADR-024 sponsored products (flag `ADS_ENABLED`, off by default):** ad wallet (append-only, idempotent), campaigns with staff review, trust floor 50 / tier ≥ 1, labelled slots on search and "similar sponsored" on the product page, invalid-click filtering + 72h re-score, settlement, enquiry attribution (click cookie, then last click), `/ranking-and-ads` disclosure; an organic-integrity test proves organic order is identical with ads on and off.
- **ADR-025 promotions:** editorial promotions, seller offers validated against the LIVE listing price (reference-price honesty, `ListingPriceHistory`), offer-honour reports, coupons (one per GSTIN) on checkout, referrals (`?ref=` captured at signup, risk flags for rings/shared phone/GSTIN, staff review of rewards); offers shown on product cards.
- **Still open:** seller-app i18n, geo targeting for ads on search, ads notification templates, Phase 2 (ADR-012 to 017) and Phase 3 (ADR-019 to 023).
**Status values:** Implemented (Phase-1 scope is met) / Partial / Not started / Deferred by phase (the ADR itself is a Phase 2 or 3 item and correctly unbuilt).
**Answer to "did we add all the ADRs?":** all 24 accepted or proposed decisions in ADR-000 to ADR-023 are recorded, and the Phase 1 ones are largely built. The Phase 1 ADRs with real holes are ADR-004 (WhatsApp, voice, vernacular), ADR-002 (reachability verification), ADR-003 (T2/T3 tiers) and ADR-005 (real payments). Fourteen decisions taken during the build are now recorded as ADR-026 to ADR-039 (this folder).

## Summary

| Result | Count | ADRs |
|---|---|---|
| Implemented | 4 | 000 (drivers), 006, 007, 008 |
| Partial | 6 | 001, 002, 003, 005, 009, 010 |
| Partial, mostly not started | 1 | 004 |
| Not started (decision pending) | 1 | 011 |
| Deferred by phase | 12 | 012 to 023 |
| Proposed, design only | 2 | 024, 025 |

## Phase 1 ADRs

### ADR-000: Problem statement and drivers. Implemented (as guiding text)
Nothing to build. Drivers 1 to 7 are visible in code: trust weighting (`identity/trust.ts`), AI behind interfaces (`@cnote/ai`), no card data, small-team modular monolith. Driver 4 (Bharat-native: voice, vernacular, WhatsApp, feature-phone) is the weakest; see ADR-004. Driver 6 (ONDC-ready) is untouched by design (Phase 2 to 3).

### ADR-001: Hybrid, lead-first business model. Partial
- **Evidence:** `billing` (Plan, Subscription, CreditLedgerEntry), `enquiry` (Enquiry, Match, Conversation, Quote, DealReport), lead credits consumed on accepted leads.
- **Gaps:** payment capture is mocked (`billing/subscriptions.ts`: "payment is mocked in Phase 1"); no real collection, GST invoice or refund rail. Escrow and take-rate are correctly not built. Order lifecycle entities exist for Enquiry to Quote but there is no `Order` model yet (ADR-007).
- **Metrics:** none for revenue; no "deal closed off-platform but unprovable" trigger measure (the ADR-001 review trigger). `DealReportedOffPlatform` events exist to compute it.

### ADR-002: AI intent-scored exclusive matching. Partial (core built, reachability not)
- **Evidence:** `ai.scoreIntent` (heuristic + Anthropic providers, logged decisions); `enquiry/scoring.ts` (`rankCandidates`: embedding cosine x reliability x geo, `assignSlots` cap N=3), `matching.ts` (cascade), `leads.ts` (accept, decline within window, expire sweep job each minute, `LeadRefunded` with reasons `buyer_unreachable`, `buyer_fake`, `enquiry_rejected`, 72h `REFUND_WINDOW_MS`), `buyer.ts` (buyer preference for manual choice), `ReviewItem` ops queue for low confidence, admin `queues` and `leadgen` pages. Events: `EnquiryScored`, `LeadMatched`, `LeadAccepted`, `LeadDeclined`, `LeadExpired`, `LeadRefunded`.
- **Gaps (specific):**
  1. **No automated reachability verification.** The ADR wants an automated callback/OTP/WhatsApp check that the buyer is reachable. Today "unreachable or fake" is flagged by the seller and refunds follow; no telephony/WhatsApp provider is integrated. The only verified-phone signal is the buyer's OTP at capture (`leadgen`, `identity/phone-login`).
  2. **Real OTP delivery is not wired.** `OTP_DEV_ECHO=true` logs the code; no SMS (TRAI DLT templates) or WhatsApp authentication-template sender exists in packages (design is in `docs/design/lead-generation.md`). Production sign-in by phone and lead capture cannot go live without it.
  3. Intent inputs listed in the ADR that are missing: device/behavioural signals and historical response ratio are only partly present (`buyerPriorEnquiries/Responded`, near-duplicate similarity exist; device signals do not).
  4. Fake-lead precision/recall (>= 90% / 80%) cannot be measured: no labelled set, no ops-labelling feedback loop into training.
- **Metrics:** lead-to-conversation, conversation-to-deal, auto-refund rate are derivable from the event log but there is no query, dashboard or job that computes them. Instrumentation status: events yes, aggregation no.

- **Wave 4 update:** real OTP delivery adapters exist (MSG91 SMS with DLT template, WhatsApp Cloud authentication template, WhatsApp→SMS fallback), selected by `OTP_SENDER` and resolved lazily in every process; production needs credentials only. Gate metrics (lead→conversation, conversation→deal, auto-refund rate, response time) are now computed daily by `@cnote/metrics` with SLO alerts. Still open: automated buyer reachability callback, device signals, fake-lead precision/recall (needs labelled data).
### ADR-003: Tiered, API-driven, continuous verification. Partial
- **Evidence:** T0 phone OTP, T1 GSTIN checksum + GSTN provider (mock in dev) + Udyam format (`identity/business.ts verifyGstin`, `gstin.ts`); `VerificationRecord` with kinds `phone_otp, gstin, udyam, document, video_kyc, audit`; continuous `trust.ts` score (tier x SLA x deals x disputes x moderation flags, inactivity decay, badge threshold) with `trust-worker.ts` and `TrustScoreChanged`; prohibited-category `ai.moderate` on listings and versions; `moderation` and `businesses` admin screens; takedown via admin moderation.
- **Now built (30 Sep):** `identity/src/gst` with Cashfree and Surepass GSTIN adapters behind a `GstnProvider` port (mock in dev/CI), scored checks (status Active, legal/trade-name match, state code, PAN linkage, GSTR-3B filing regularity where the provider returns it, HSN alignment against the seller's listings), a staff review queue for ambiguous outcomes, monthly continuous re-verification that revokes the badge on Cancelled/Suspended, PAN stored field-encrypted and always masked.
- **Gaps:** GST provider credentials not configured (runs on the mock until `GST_PROVIDER` + keys are set; Surepass field names still to confirm against their docs); no Udyam API verification, only format; no MCA/CIN lookup (format only); **T2 not built** (document forensics, VLM checks, liveness/video KYC: enum values only); **T3 audit partner flow not built**; no published takedown/appeal workflow for sellers (DPDP/IT Rules) beyond the admin moderation queue; badge revocation below threshold is computed but the "false-badge rate" is not measured.
- **Metrics:** none implemented for T1+ share or false-badge rate.

- **Wave 4 update:** T1+ seller share and a false-badge proxy are measured daily (`@cnote/metrics`); moderation decisions can be appealed by sellers (`@cnote/compliance`). Still open: provider credentials, T2 (document/video KYC), T3.
### ADR-004: Vernacular, voice-first, WhatsApp-native onboarding. Partial, mostly not started (largest gap vs the ADR)
- **Evidence:** `ai.extractListing` (free text, or a transcribed note, into a structured listing; languages typed `en hi kn ta te mr gu bn`); `catalogue.draftListingFromText`; category schema validation before publish (`catalogue/validate.ts`); AI drafts flagged and re-moderated; Hinglish-aware query normalisation in search (`search/normalise.ts`); seller `onboarding` and web `onboarding` routes (web/tertiary path); `voice_retention` consent purpose exists.
- **Gaps (specific):**
  1. **WhatsApp Business Platform channel: not started.** No webhook, no session state machine, no template registry, no cost tracking. `docs/research/seller-onboarding.md` is research only. ADR-004 names WhatsApp as the primary channel; the built channel is the tertiary one.
  2. **Voice / ASR / TTS: not started.** The `transcribe` capability named in the ADR and CLAUDE.md is absent from `@cnote/ai` (no Sarvam or other ASR provider interface). There is no voice-note upload, storage, retention job or consent flow, though the consent purpose exists.
  3. **VLM catalogue-from-photo: not started.** `extractListing` takes text only; no image input, no VLM provider.
  4. **Vernacular UI: not started.** `apps/web` renders `lang="en-IN"`; no i18n framework, no string catalogues, no hreflang alternates (the layout has a comment marking where to add them). `Lang` type exists only in the AI contract.
  5. Android app (secondary channel): not started.
  6. HSN/category suggestion exists in `extractListing` output (hsn field) but is not validated against a master list.
- **Metrics:** time-to-first-published-listing, onboarding completion, AI-draft edit rate: events exist (`ListingPublished`, `ListingVersionSubmitted`) but nothing computes the metrics; edit rate needs the draft/diff stored, which is not.

- **Wave 4 update (now Partial, substantially built):** WhatsApp Cloud API channel with signed webhooks, consent-first seller onboarding conversation in English/Hindi (business → photos/voice note → AI draft → submit for review), `ai.transcribe` (Sarvam, mock without keys) and `ai.extractListingFromImages` (Claude vision) wired into seller-app "Create from photos" / "Describe by voice"; voice audio is private-only and deleted within 24h unless `voice_retention` consent; buyer web has Hindi (`/hi`, statically generated, hreflang). Time-to-first-listing and onboarding completion are measured. Still open: Meta/Sarvam credentials, the other 6 languages (catalogue stubs exist), Hindi native review, Android app, seller-app i18n.
### ADR-005: Transparent, self-serve pricing. Partial
- **Evidence:** public `pricing` page in `apps/web`; `billing/plans.ts` (Free/Starter/Pro), lot-based credits with 90-day rollover (`CREDIT_TTL_DAYS`), auto-refund per ADR-002, `autoRenew` always false, append-only ledger, integer paise.
- **Gaps:** real payment collection and GST invoicing (mocked); in-app pricing calculator not evidenced; annual plans with pro-rated refund not built; self-serve cancel in <= 3 taps not verified; renewal-confirmation email flow exists only as template plumbing; "ranking boost tied to trust score" is implemented through `trustFactor` in search, but nothing explicitly asserts plan never affects rank (a test is proposed in ADR-024).
- **Metrics:** none (ARPU, retention, refund complaints).

### ADR-006: Modular monolith. Implemented (stack superseded by ADR-026)
- **Evidence:** 24 workspace packages, each with a single `src/index.ts` contract; package `exports` and declared dependencies enforce boundaries; each module owns its Prisma schema file; domain events for cross-module integration; the worker hosts observers. Extraction candidates (search, AI) already sit behind ports (`index-port`, provider registry).
- **Gaps:** boundary rules are enforced by convention plus `exports`; no automated dependency-graph lint (ArchUnit-style) in CI, so cycles are caught only by review or typecheck. Stack differs from the ADR (Next.js/TypeScript, Redis Streams; see ADR-026).

- **Wave 4 update:** the missing build rule now exists: `pnpm check:boundaries` (declared deps, allowed graph, no cycles, framework-free domain packages, Prisma model ownership) runs in CI with zero debt entries.
### ADR-007: Data model and event log. Implemented (Phase 1 scope)
- **Evidence:** `Business` with roles; `Person`, `VerificationRecord`, `Listing`, `Enquiry`, `Match`, `Conversation`, `Message`, `Quote`, `DealReport`; append-only `DomainEvent` written through a transactional outbox (`core/events/emit.ts`, `catalog.ts` with per-type version), 50 event types; purpose-scoped `Consent` ledger; language tag, embedding version and moderation status on listings and enquiries; append-only credit ledger; integer paise.
- **Gaps:** `Order`, `EscrowTransaction`, `Dispute`, `CreditEvent` entities absent (Phase 2 to 3, but the ADR says model the lifecycle now: at least `Order` should exist as a stub); the relationship graph is not materialised from events; no event-schema registry check in CI beyond the catalogue's typed versions; the `DomainEvent` retention/partitioning policy is undefined.

- **Wave 4 update:** `Order` exists (off-platform in Phase 1, recorded from won deals, two-party confirmation, strict state machine, `OrderRecorded`/`OrderStatusChanged`), so ADR-012 escrow can attach to real rows; event log has a `(type, occurred_at)` index for metrics.
### ADR-008: AI stack. Implemented for Phase 1 capabilities
- **Evidence:** `@cnote/ai` is the only vendor caller; capabilities `scoreIntent`, `embed`, `extractListing`, `moderate` behind provider interfaces (`registry.ts`); providers `heuristic` (offline default for CI) and `anthropic`; every decision logged to `AiDecision` with prompt version, model ID, redacted input (`redact.ts`), latency; `ReviewItem` queue when confidence < threshold (`moderate` "review" always goes to a human); golden-set eval harness (`packages/ai/evals`, `test/evals.test.ts`); input retention purge at 180 days; embedding version tracking with re-index.
- **Gaps:** `transcribe` (ASR/TTS) and VLM capabilities not implemented (see ADR-004); no shadow-mode promotion mechanism; no in-house trained classifiers (data is not yet accruing at scale); ops labels are stored on the review item but not exported for training; eval gating in CI is limited to the heuristic provider (no scheduled Anthropic eval).
- **Metrics:** latency is logged per decision; no p95 dashboard, no matching < 2s SLO alert.

- **Wave 4 update:** `transcribe` and vision extraction capabilities added with provider ports, decision logging (no image/audio bytes stored), review thresholds and golden-set eval hooks; moderation v2 catches obfuscated listings.
### ADR-009: Hybrid search. Partial (OpenSearch superseded for Phase 1 by ADR-026)
- **Evidence:** Postgres FTS + pgvector hybrid fusion (`search/fusion.ts`, `search.ts`, `suggest.ts`), Hinglish query normalisation and location hint, rank = relevance x trust (`trustFactor`), Redis result caching with tag invalidation (`cache-worker.ts`). `SEARCH_BACKEND=postgres|opensearch` port with a shipped OpenSearch adapter (Indic analyzer, typo tolerance, facets, alias-swap reindex, event-driven indexer; ranking parity with Postgres is tested) so the ADR's original stack is one config switch away.
- **Gaps:** synonyms/transliteration for non-Latin vernacular scripts not implemented (Hinglish fillers only); **image-to-product search not started**; **voice search not started** (needs ASR); sponsored slots not built (ADR-024); no relevance judgement set or nDCG tracking; OpenSearch adapter is unproven in production.
- **Metrics:** search latency and zero-result rate are not instrumented beyond `Server-Timing`.

### ADR-010: Compliance, privacy, residency. Partial
- **Evidence:** append-only purpose-scoped consent ledger (`ConsentPurpose`: matching, marketing, voice_retention, counterparty_sharing) and `consent.ts`; data export and erasure (`identity/privacy.ts exportPersonalData/erasePerson`, `DataErasureRequested` event); PII redaction before model calls; DPDP-safe Sentry scrubbing (`@cnote/observability`); Clarity only after analytics consent; append-only admin audit log; staff RBAC; prohibited-category classifier; no card data.
- **Gaps:** **data residency is not enforced or documented in code**: no region config, and the deploy manifests do not yet pin an India region (see `docs/architecture/portability.md`); no 72-hour breach-notification runbook in the repo; no grievance-officer workflow; retention policies exist only for AI inputs (180 days), not for enquiries, messages or voice; erasure coverage across all modules is unverified; appeal route for takedowns missing; "SOC2-style controls" not evidenced (secrets management arrives with ADR-036/037); a DPDP notice/consent-text versioning process is missing.
- **Metrics:** none (consent rates, erasure SLA).

- **Wave 4 update:** per-module retention policies with a `RetentionRun` audit log, grievance officer workflow with SLA tracking (web `/grievance`, admin queue), moderation appeals, data-residency startup guard (`DATA_RESIDENCY_ENFORCE`), and `docs/compliance/` (72h breach runbook, retention schedule, grievance process, DPDP checklist). Still open: counsel review of DPDP rule references, 48h erasure notice, nomination right, R2 India pinning (not available; acknowledged via `DATA_RESIDENCY_R2_ACK`).
### ADR-011: Phase-1 vertical selection. Not started (decision pending, correctly gated)
- **Evidence:** the code is category-config-driven (`Category.attributeSchema`, `ai.extractListing` takes categories), as CLAUDE.md requires. Seed data is dummy.
- **Gap:** the vertical is undecided, so no category schemas, classifier fine-tunes, or seller-cluster acquisition plan exist. Blocks meaningful eval sets and vernacular language ordering.

## Phase 2 and 3 ADRs (Deferred by phase)

| ADR | Topic | In code today | Note |
|---|---|---|---|
| 012 | Escrow via PA partner | Nothing (no `Order`, ledger is credits only) | Deferred. Phase-1 data model should get an `Order` stub. Double-entry ledger not started |
| 013 | AI dispute resolution | `disputesLost` is a trust-score input only; no `Dispute` model | Deferred |
| 014 | RFQ quote agent | `Quote`, `sendQuote`, RFQ web route exist (manual). No agent | Deferred; `ai` has no quote capability |
| 015 | CV quality checks | Nothing | Deferred |
| 016 | Vertical playbook | Category schema config is the seed of it | Deferred |
| 017 | ONDC adapter | Nothing | Deferred |
| 018 | Service extraction | Search port and AI provider registry are the seams | Deferred |
| 019 | Embedded credit | Nothing | Deferred |
| 020 | Agent-to-agent | **Partially accelerated:** public REST API and MCP with scoped personal API keys (`apps/api`, `@cnote/developer`); see ADR-032. No negotiation protocol | Foundation only |
| 021 | ONDC live | Nothing | Deferred |
| 022 | Price intelligence | Nothing (no price history table; ADR-025 proposes `ListingPriceHistory`) | Deferred |
| 023 | Scale and multi-region | Queue/event transport ports (Redis now, Kafka stub in `core/queue/kafka.ts`), live read DB (CQRS), containers and k8s base | Foundations; DR and CDC not started |

## Proposed ADRs

| ADR | Topic | Status in code |
|---|---|---|
| 024 | Sponsored placements | Design only (`docs/design/promotions-and-sponsored.md`). No `@cnote/ads`. Prerequisites missing: real payments, `trustFactor` moved to identity |
| 025 | Promotions and offers | Design only (`promotions-schema.prisma.md`). No `@cnote/promotions`; `ListingPriceHistory` not written. Coupons need billing payment capture |

## Metrics instrumentation status (across ADRs)

- **In place:** domain event log (source data for every funnel metric); AI decision log with latency and confidence; `leadgen.funnelByTriggerDay`; API key usage per day (`ApiKeyUsageDaily`); storefront traffic per day (`StorefrontTrafficDaily`, privacy-preserving); Sentry (scrubbed) and consented Clarity.
- **Wave 4:** `@cnote/metrics` now computes the ADR targets daily from the event log (see docs/design/metrics.md) with SLO alerts and an admin scorecard; the list below is the pre-wave-4 state.
- **Missing (before wave 4):** no metrics job or warehouse view computes any ADR target (lead to conversation, conversation to deal, refund rate, T1+ share, time-to-first-listing, onboarding completion, edit rate, fake-lead precision/recall, ops queue age). No product-analytics dashboard in admin beyond queues. No SLO alerts (matching < 2 s, ad decision < 30 ms).

## Prioritised gap list for Phase 1

| # | Gap | ADR | Why now | Rough size |
|---|---|---|---|---|
| 1 | Production OTP delivery: SMS (DLT) and WhatsApp authentication template providers behind a port, plus reachability re-check | 002, 003, lead-gen doc | Lead capture and phone login cannot launch without it; also unlocks the reachability check | M |
| 2 | Real payment capture + GST invoicing for plans (or a manual finance-credit process documented) | 001, 005 | Revenue; also a prerequisite for ADR-024/025 | L |
| 3 | WhatsApp seller onboarding channel (webhook, conversation state, templates, consent) | 004 | Primary onboarding path in the ADR; today only the tertiary web path exists | L |
| 4 | Voice notes + ASR capability (`transcribe`) and photo-to-listing VLM extraction | 004, 008, 009 | Core of the onboarding promise and of voice/image search | L |
| 5 | Vernacular UI: i18n framework, Hindi first, hreflang, translated key flows | 004 | Bharat-native driver; currently English only | M |
| 6 | GST provider credentials + T2 verification (document + video KYC) | 003 | Trust is the product; T1 checks are built but run on the mock until keys are set | M |
| 7 | Data residency pinning, retention policies per module, 72h breach runbook, appeal workflow | 010 | Compliance moat and legal exposure | M |
| 8 | Metrics layer: SQL views or a job over `DomainEvent` for each ADR target, admin dashboard, SLO alerts | 002 to 005 | Phase 1 gate cannot be evaluated without it | M |
| 9 | Decide the Phase-1 vertical; load real category schemas and golden sets | 011 | Unblocks evals, language order and seller acquisition | S (decision) |
| 10 | `Order` stub entity and boundary lint (dependency graph check in CI) | 006, 007 | Cheap now, expensive to retrofit | S |
