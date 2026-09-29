# Architecture Decision Records — AI-First B2B Marketplace (India)

**Working name:** *TBD* (referred to below as "the Platform")
**Owner:** Madan (Founder / Staff Engineer)
**Status legend:** `Proposed` · `Accepted` · `Deferred` · `Superseded`
**Version:** 0.1 — 6 Sep 2026
**Related:** Research Report (competitor, pain-point and AI-opportunity analysis, Sep 2026); DDR (to follow per phase)

---

## 0. How to read this document

Each ADR follows: **Context → Options → Decision → Rationale → Consequences → Exit / review criteria**. Decisions are grouped by phase. A later phase never silently contradicts an earlier one; if a decision changes it is marked `Superseded by ADR-xxx`.

Phases are gated on measurable outcomes, not dates. Indicative timelines are given so the roadmap is legible, but the gate is the number.

| Phase | Theme | Indicative window | Gate to next phase |
|---|---|---|---|
| **1** | Trust-first lead marketplace, one vertical, AI trust layer | 0–6 months | Exclusive-lead → deal conversion ≥ 2× IndiaMART-style broadcast baseline; ≥ 500 verified sellers; fraud-flag precision ≥ 90% |
| **2** | Transactions: escrow, disputes, RFQ negotiation, 2–3 verticals | 6–15 months | ≥ 20% of matched leads convert to escrowed orders; dispute median resolution < 7 days; net seller adds positive for 3 consecutive months |
| **3** | Financial and network layer: credit, agent-to-agent commerce, ONDC live, price intelligence | 15–30 months | Take-rate + subscription revenue covers CAC; credit partner NPA < 2%; ONDC order share measurable |

---

## ADR-000 — Problem statement and decision drivers

**Status:** Accepted

**Context.** IndiaMART dominates Indian online B2B lead-gen (~60% share, ₹1,388 Cr FY25 revenue, ₹550 Cr PAT) yet scores 1.3–1.6/5 across review sites. Its top complaint themes — fake/irrelevant leads, leads broadcast to many sellers, opaque rep-sold pricing, refund refusals, no accountability for buyer fraud — are structural to its business model, not execution errors. Transactional players (Udaan, Bizongo) demonstrate that inventory + credit-heavy models are capital-hungry and fragile. Alibaba's Accio (10M+ MAU) shows agentic B2B sourcing is real and scaling; no incumbent has built it for vernacular, low-literacy Indian MSMEs with a genuine trust layer.

**Decision drivers (in priority order).**
1. **Trust is the product.** Every architectural choice must make leads, sellers and transactions more verifiable than IndiaMART's.
2. **AI-first, not AI-added.** Intent scoring, matching, verification, cataloguing, negotiation and disputes are AI-native workflows with human-in-the-loop, not bolt-ons.
3. **Capital-light first.** No inventory, no balance-sheet lending before Phase 3.
4. **Bharat-native.** Voice, vernacular, WhatsApp, low bandwidth, feature-phone-tolerant flows.
5. **Compliance as moat.** DPDP Act 2023 / Rules 2025, RBI PA Master Direction (Sep 2025), GSTN/Udyam, intermediary-liability trend (CDSCO/CCPA actions against IndiaMART).
6. **Interoperable.** ONDC-adapter-ready from day one; avoid walled-garden lock-in.
7. **Small team velocity.** Architecture must be operable by < 10 engineers for the first 12 months.

**Non-goals (all phases).** Consumer (B2C) retail; cross-border export in Phase 1–2; owning logistics assets; building our own LLM.

---

# PHASE 1 — Trust-first lead marketplace (0–6 months)

## ADR-001 — Business model: hybrid, lead-first

**Status:** Accepted

**Context.** Three viable archetypes exist: (A) lead/subscription (IndiaMART), (B) escrowed-transaction take-rate (Alibaba Trade Assurance, Faire), (C) transactional/inventory + credit spread (Udaan, OfBusiness).

**Options.**
- A. Pure lead/subscription with AI premium.
- B. Pure transactional take-rate from day one.
- C. Inventory-led wholesale + credit.
- D. **Hybrid: lead/subscription core in Phase 1, optional escrowed transactions in Phase 2, credit facilitation in Phase 3.**

**Decision.** Option D.

**Rationale.** Lead economics are proven profitable and capital-light; the trust deficit is what an AI layer can uniquely fix. Escrow needs an RBI-authorized PA partner and transaction density to be meaningful — premature in Phase 1. Option C's failure modes (Udaan ₹1,055 Cr loss, Bizongo restructuring) are well documented.

**Consequences.** Revenue in Phase 1 is subscription + per-lead only; escrow and take-rate rails are designed for but not built. Data model must capture the full enquiry → quote → order lifecycle from day one even though orders are off-platform initially (see ADR-007).

**Review.** Revisit if Phase-1 gate is met but sellers report leads convert off-platform with no way to prove it — that is the trigger for accelerating escrow.

---

## ADR-002 — Lead product: AI intent-scored, exclusive (capped) matching

**Status:** Accepted

**Context.** IndiaMART broadcasts each BuyLead to many sellers, triggering price wars and low conversion; sellers cannot tell fake from real. This is the single most-cited complaint.

**Options.**
1. Broadcast to all category sellers (incumbent model).
2. Auction leads to highest bidder.
3. **AI-ranked exclusive matching with a hard cap (default 3 sellers per lead), intent score visible to seller, lead credit refunded automatically if the buyer is unreachable/fake.**
4. Buyer picks sellers manually from ranked list (no auto-assignment).

**Decision.** Option 3, with Option 4 available as a buyer preference.

**Design.**
- **Intent score (0–100)** from: buyer verification level, requirement specificity (quantity, spec, location, timeline), device/behavioural signals, phone/email reachability check (automated callback/OTP), historical enquiry-to-response ratio, duplicate/near-duplicate detection.
- **Match score** = cosine similarity of requirement embedding vs seller catalogue embeddings × seller reliability (response time, verification tier, dispute rate) × geo/logistics feasibility.
- **Cap and exclusivity:** top-N sellers (N=3 default, configurable per category) receive the lead; each sees N and their rank. A seller may decline within 2h; the slot cascades to the next.
- **Auto-refund policy:** if the buyer is unreachable (verified by automated outreach) or flagged fake within 72h, lead credits are returned without a support ticket.
- **Human-in-the-loop:** low-confidence scores route to an ops queue before release.

**Rationale.** Directly negates complaint themes 1 and 2. Automatic refunds attack theme 4 (refund refusals). Visible scores create accountability the incumbent lacks.

**Consequences.** Fewer leads per seller than broadcast platforms — the pitch is quality, not volume; marketing must frame this explicitly. Requires reachability verification infra (telephony/WhatsApp APIs) and an embedding pipeline (ADR-008).

**Metrics.** Lead → first conversation ≥ 60%; conversation → deal ≥ 15%; auto-refund rate < 10%; fake-lead precision ≥ 90%, recall ≥ 80%.

---

## ADR-003 — Seller verification: tiered, API-driven, continuous

**Status:** Accepted

**Context.** Badges on incumbent platforms (TrustSEAL, Alibaba Gold) signal payment, not reliability. Buyers do not trust them.

**Options.**
1. Self-declared + document upload, manual review.
2. **Tiered: T0 phone/OTP → T1 GSTIN + Udyam API verification → T2 document + image forensics + video KYC → T3 physical/third-party audit (partner). Continuous re-scoring from platform behaviour.**
3. Third-party verification outsourced entirely.

**Decision.** Option 2. T3 via partner (e.g., SGS/TÜV/local agencies) only when a category demands it.

**Design.**
- GSTN public API / GSP for GSTIN status, filing regularity, registered address and HSN alignment with listed products.
- Udyam registration verification for MSME status.
- Document forensics (VLM + classical checks) on GST certificate, PAN, bank proof; liveness/video KYC for T2.
- **Continuous trust score:** verification tier × response SLA adherence × buyer feedback × dispute outcomes × content-moderation flags. Score decays if activity/behaviour degrades; badge is revoked automatically below threshold.
- Prohibited-category classifier at listing time (pharma, explosives, hazardous chemicals, weapons) — proactive moderation given the CDSCO/CCPA precedent.

**Rationale.** Verification that is continuous and behaviour-linked is what neither IndiaMART nor Alibaba offers. Proactive moderation converts intermediary-liability risk into a compliance advantage.

**Consequences.** Onboarding friction rises at T1+; mitigate with vernacular guided flows (ADR-004). GSP/API costs per verification. Need a documented takedown/appeal process (DPDP + IT Rules).

**Metrics.** ≥ 80% of active sellers at T1+ within 90 days; false-badge rate (verified seller later found fraudulent) < 0.5%.

---

## ADR-004 — Seller onboarding and catalogue: vernacular, voice-first, WhatsApp-native, catalogue-from-photo

**Status:** Accepted

**Context.** The majority of Bharat MSMEs are low-digital-literacy and non-English. Catalogue creation is the biggest onboarding drop-off on incumbents.

**Options.**
1. Web/app form-based onboarding (incumbent).
2. Field sales force builds catalogues (IndiaMART/JustDial model — expensive, slow).
3. **AI-assisted onboarding: WhatsApp (and app) conversation in the seller's language; seller sends photos + voice notes; VLM extracts product attributes, ASR transcribes, LLM drafts structured listings; seller confirms via voice/tap.**

**Decision.** Option 3, with a lightweight web/app path for digitally fluent sellers.

**Design.**
- Channels: WhatsApp Business Platform (primary), Android app (secondary), web (tertiary).
- Languages: Hindi, Kannada, Tamil, Telugu, Marathi, Gujarati, Bengali + English at launch (Phase-1 vertical decides ordering).
- Models: Indian-language ASR/TTS (Sarvam or equivalent), VLM for product-attribute extraction, LLM for listing generation and HSN/category suggestion; all outputs go through a category schema validator before publish.
- Every AI-generated listing is marked as such internally and re-checked by the prohibited-category classifier (ADR-003).

**Rationale.** Removes the single biggest onboarding barrier; no incumbent has shipped this end-to-end. Also generates structured, embeddable catalogue data which powers ADR-002 matching.

**Consequences.** WhatsApp template/conversation costs; dependency on third-party Indian-language models (abstract behind an interface — ADR-008). Voice data is personal data under DPDP: consent capture and retention policy required (ADR-010).

**Metrics.** Median time-to-first-published-listing < 15 minutes; onboarding completion ≥ 60%; listing edit rate after AI draft < 30%.

---

## ADR-005 — Pricing: transparent, self-serve, success-aligned

**Status:** Accepted

**Context.** Opaque rep-negotiated pricing, upgrade traps and auto-renewals are the third most common incumbent complaint.

**Decision.**
- All plans published publicly with an in-app calculator; no sales-rep-only pricing.
- **Free** tier: verified listing, receive capped leads with intent score visible, reply via WhatsApp.
- **Starter / Pro** monthly tiers: lead credits, ranking boost tied to trust score (not payment), analytics. Monthly billing by default; annual optional with pro-rated refund on cancellation.
- **Per-lead credits** consumed only on accepted leads; auto-refunded per ADR-002. Unused credits roll over 90 days (vs incumbent weekly lapse).
- No auto-upgrade; renewals require explicit confirmation; cancellation self-serve in ≤ 3 taps.

**Rationale.** Pricing transparency is itself a marketing wedge against incumbents' complaint volume. Rollover + auto-refund address the two most quantifiable grievances.

**Consequences.** Lower ARPU than IndiaMART initially; compensated by lower CAC (no field sales) and higher retention. Billing system must support metering, rollover and pro-rata refunds from day one.

---

## ADR-006 — Core platform architecture: modular monolith, service-ready boundaries

**Status:** Accepted

**Context.** Small team; need velocity now and a path to services later.

**Options.**
1. Microservices from day one.
2. **Modular monolith with strict module boundaries (Identity/Verification, Catalogue, Enquiry & Matching, Messaging, Billing, Moderation, Search, AI-Orchestration), async integration via an event bus, extract to services only when a module has independent scaling or team-ownership needs.**
3. Serverless-first.

**Decision.** Option 2.

**Stack (indicative; finalise in DDR).** Kotlin/Spring or Go for core; Python services for ML/agents; PostgreSQL (primary, with pgvector for early embeddings); Kafka (or managed equivalent) as event backbone; Redis for caching/rate-limits; OpenSearch for search; object storage for media; Kubernetes on an India-region cloud (Mumbai/Hyderabad) for data residency.

**Rationale.** Matches team size, keeps the door open to extraction (AI-Orchestration and Search are the first likely candidates), and keeps a single deployable for the first year.

**Consequences.** Discipline on module boundaries (enforced via build rules/ArchUnit-style checks). Event schemas versioned from day one (ADR-007).

---

## ADR-007 — Data model and event log: lifecycle-first, graph-aware

**Status:** Accepted

**Context.** Phase-2 escrow, Phase-3 credit underwriting and price intelligence all depend on a clean, complete history of enquiry → quote → order → fulfilment → dispute, even when early orders happen off-platform.

**Decision.**
- Canonical entities: `Business` (buyer/seller are roles, not types), `Person`, `VerificationRecord`, `Listing`, `Enquiry`, `Match`, `Conversation`, `Quote`, `Order` (Phase 2), `EscrowTransaction` (Phase 2), `Dispute` (Phase 2), `CreditEvent` (Phase 3).
- **Append-only domain event log** (`EnquiryCreated`, `LeadMatched`, `LeadAccepted`, `ConversationStarted`, `QuoteSent`, `DealReportedOffPlatform`, …) as the source of truth for analytics and ML features.
- Relationship graph (Business ↔ Business ↔ Category ↔ Location) materialised from events; start in PostgreSQL, evaluate a graph store only if traversal queries dominate.
- Every listing and enquiry carries a language tag, embedding version and moderation status.
- Consent ledger per Person/Business (ADR-010) is a first-class entity, not metadata.

**Rationale.** Off-platform deals still need to be *reported* (with a one-tap "did this close?" prompt) so that intent scoring learns and Phase-3 underwriting has history.

**Consequences.** Slightly heavier write path; strong schema governance needed. Pays off in Phase 2–3.

---

## ADR-008 — AI stack: orchestration layer, model-agnostic, Indian-language capable

**Status:** Accepted

**Context.** Phase 1 needs: intent scoring, embeddings/matching, fraud/proxy detection, VLM catalogue extraction, ASR/TTS, listing generation, prohibited-content classification. Phase 2–3 add negotiation, dispute mediation, agent-to-agent commerce.

**Decision.**
- A single **AI-Orchestration module** exposing typed capabilities (`score_intent`, `match`, `extract_listing`, `moderate`, `transcribe`, …) behind provider-agnostic interfaces. No product module calls a model vendor directly.
- **Frontier LLM** (via API) for reasoning-heavy tasks; **Indian-language models** (ASR/TTS/OCR) via API for vernacular; **small fine-tuned classifiers** (intent, fraud, prohibited-category) trained in-house on platform data as it accrues — these are cheap, fast and become the moat.
- Retrieval layer: embeddings over listings, enquiries and seller profiles; version every embedding; re-index on model upgrade.
- Evaluation harness from day one: golden sets per capability, offline metrics gating any model/prompt change; online shadow mode before promotion.
- Human-in-the-loop queues for every capability with a confidence threshold; ops labels feed back into training.
- Prompt/versions, model IDs and inputs logged (redacted per DPDP) for every decision affecting a user (auditability).

**Rationale.** Vendor optionality, cost control, and a data flywheel: proprietary labelled data on Indian B2B intent/fraud is the defensible asset, not the LLM.

**Consequences.** Upfront investment in eval infra; discipline to keep prompts and classifiers versioned. Latency budgets: matching < 2s synchronous, cataloguing may be async.

---

## ADR-009 — Search and discovery: hybrid lexical + semantic + multimodal

**Status:** Accepted

**Decision.** OpenSearch (BM25, synonyms, transliteration for Hinglish/vernacular queries) fused with vector retrieval (pgvector initially; dedicated vector DB only if scale demands); image-to-product search via VLM embeddings; voice search via ASR → same pipeline. Rank by relevance × trust score (ADR-003), never by paid tier alone; sponsored slots clearly labelled.

**Rationale.** Buyers on Bharat platforms search in mixed scripts and by photo. Trust-weighted ranking is the antithesis of pay-to-rank and reinforces ADR-005.

---

## ADR-010 — Compliance, privacy and data residency by design

**Status:** Accepted

**Decision.**
- All personal data stored and processed in India regions; model-vendor calls restricted to providers with India-region endpoints or with DPDP-compliant cross-border terms; PII minimised/redacted before external model calls.
- Consent ledger (ADR-007) with purpose-scoped consents (matching, marketing, voice retention, sharing with a matched counterparty).
- Data-principal rights (access, correction, erasure, grievance) exposed self-serve; 72-hour breach-notification runbook.
- Content moderation and takedown workflow with appeal; prohibited-category policy published.
- Security baseline: SOC2-style controls, secrets management, audit logging; PCI scope avoided in Phase 1 (no card data held) and prepared for Phase 2 via the PA partner.

**Rationale.** IndiaMART's 2020 data leak and 2025–26 regulatory actions show compliance is a differentiator and a real liability.

---

## ADR-011 — Phase-1 vertical selection

**Status:** Proposed (decide before build)

**Criteria.** High fraud/quality pain, structured specs (embeddable), repeat purchase, Bengaluru-reachable seller clusters, low regulatory risk.

**Shortlist.** (a) Industrial MRO & safety supplies, (b) packaging materials, (c) construction hardware & fasteners, (d) apparel/textile job-work (Tiruppur–Bengaluru corridor).

**Recommendation.** Start with (a) or (b); avoid pharma/chemicals in Phase 1 due to regulatory exposure. Decision to be recorded with rationale when field validation (20+ seller and buyer interviews) completes.

---

# PHASE 2 — Transactions and disputes (6–15 months)

## ADR-012 — Escrow via RBI-authorised Payment Aggregator partner

**Status:** Proposed

**Context.** Buyer-side fraud/non-delivery with "we are only an intermediary" is the top buyer complaint. RBI PA Master Direction (Sep 2025) formalises escrow requirements; obtaining our own PA licence is a 12–18-month, capital-intensive path.

**Options.**
1. Apply for PA licence.
2. **Partner with an authorised PA/bank for escrow-style nodal flows; the Platform orchestrates milestones, the partner holds funds.**
3. Third-party escrow marketplace product.

**Decision.** Option 2 for Phase 2; re-evaluate Option 1 in Phase 3 based on volume.

**Design.** Milestone-based release (order confirmed → dispatched → delivered/accepted → auto-release after N days or on buyer acceptance); GST-compliant invoicing generated on-platform; UPI/NEFT/net-banking rails; per-order fee (target 1–2%, capped) charged only on escrowed orders; escrow optional per deal, strongly nudged for first-time counterparties.

**Consequences.** Dependency on partner SLAs; reconciliation and ledger module needed (double-entry, immutable). Becomes the revenue path beyond subscriptions.

**Metrics.** ≥ 20% of matched leads convert to escrowed orders; escrow-order fraud rate < 0.5%; payout latency < 1 business day post-release.

---

## ADR-013 — AI-mediated dispute resolution with human adjudication

**Status:** Proposed

**Context.** Alibaba Trade Assurance's mediation is widely described as slow and seller-biased; ONDC's unbundled model is weak on disputes. A fast, evidence-driven process is a differentiator.

**Decision.**
- Structured dispute intake (voice/vernacular allowed); AI collects and summarises evidence (conversation history, quote, invoice, photos, logistics scans), classifies dispute type, checks against the order's agreed specs, and produces a **recommended resolution with confidence and cited evidence**.
- Tiered resolution: auto-resolve only for clear, low-value, high-confidence cases (with both parties able to escalate); otherwise human adjudicator decides using the AI brief; SLA 7 days median.
- Outcomes feed seller/buyer trust scores (ADR-003) and the fraud classifiers (ADR-008).
- Published dispute policy and appeal route; escrow funds frozen during dispute.

**Consequences.** Need adjudication ops; legal review of policy; careful DPDP handling of evidence.

---

## ADR-014 — RFQ-to-quote negotiation agent (seller-side and buyer-side assist)

**Status:** Proposed

**Context.** Accio demonstrates agents negotiating price, MOQ, lead time and shipping terms within buyer parameters.

**Decision.** Ship a **seller quote-assist agent** first (drafts quotes from a structured RFQ, seller's price book and history; seller approves via WhatsApp/app), then a **buyer comparison/negotiation assist** that normalises quotes and proposes counters within buyer-set bounds. Full autonomous agent-to-agent negotiation deferred to ADR-020.

**Guardrails.** Agents never commit either party without explicit confirmation; every agent action logged and visible to the human principal; price bounds enforced server-side.

---

## ADR-015 — Computer-vision quality checks (category-gated)

**Status:** Proposed

**Decision.** Pilot pre-dispatch photo/video verification (seller uploads; VLM checks quantity, labelling, visible spec conformance against the order) in one structured category. Outputs are advisory evidence for ADR-013, not pass/fail. Expand only where accuracy > 90% on a labelled set.

---

## ADR-016 — Vertical expansion and category playbook

**Status:** Proposed

**Decision.** Codify the Phase-1 vertical as a playbook (schema, classifier fine-tunes, seller-cluster acquisition, language ordering). Add 2 verticals in Phase 2; each must reach ≥ 200 verified sellers and positive net seller adds before the next is opened.

---

## ADR-017 — ONDC adapter (read/write catalogue, receive orders), not full participation yet

**Status:** Proposed

**Decision.** Implement a Seller-Network-Participant adapter mapping Platform catalogues to ONDC Beckn schemas and ingesting ONDC orders into the Order model; keep buyer experience first-party. Go live on the network in Phase 3 (ADR-021) once dispute handling (ADR-013) can absorb ONDC's unbundled disputes.

---

## ADR-018 — Service extraction: AI-Orchestration and Search become independent services

**Status:** Proposed

**Decision.** Extract AI-Orchestration (Python, GPU-capable autoscaling) and Search from the monolith once Phase-2 load or team ownership justifies; keep Billing/Ledger inside the core until PA integration stabilises. Extraction is event-driven and non-breaking per ADR-006/007.

---

# PHASE 3 — Financial and network layer (15–30 months)

## ADR-019 — Embedded credit via NBFC partner, ML underwriting on platform data

**Status:** Proposed

**Context.** MSME credit gap is enormous (IFC 2018: ₹25.8 trn; other estimates higher); delayed payments ~₹7–8 lakh Cr. OfBusiness/Oxyzo and Moglix/Credlix show credit is where B2B platforms make money — but off their own balance sheets it is capital-intensive and regulated.

**Decision.** Partner with one or two NBFCs (referral + co-underwriting, first-loss guarantee capped and negotiated); Platform supplies a **credit score derived from verified GST filings, escrow transaction history, dispute record and behavioural signals**; invoice financing and buy-now-pay-later on escrowed orders only. No lending on own balance sheet in this phase; revisit NBFC licence at scale.

**Metrics.** Partner GNPA on Platform-originated book < 2%; credit-attached orders ≥ 15% of escrowed GMV.

---

## ADR-020 — Agent-to-agent commerce (buyer agent ↔ seller agent)

**Status:** Proposed

**Decision.** Extend ADR-014 into standing agents: buyers can delegate recurring procurement (specs, budget bounds, approved-vendor list); sellers can delegate quoting within price-book rules. Agents negotiate via a structured protocol (offer/counter/accept with typed terms), not free-text; every closed negotiation requires human confirmation unless a party has explicitly enabled auto-accept within bounds. Expose an external agent API (rate-limited, authenticated) so third-party procurement agents can transact — the opposite of Amazon's block-third-party-agents stance.

---

## ADR-021 — ONDC live participation

**Status:** Proposed

**Decision.** Activate the ADR-017 adapter as a live seller-side network participant; evaluate buyer-side participation after measuring incremental GMV and dispute load for two quarters.

---

## ADR-022 — Price intelligence product

**Status:** Proposed

**Decision.** Aggregate anonymised quote and escrow-order data into category price benchmarks (regional, volume-tiered); surface to buyers during RFQ and to sellers as competitiveness signals; sell as a premium analytics tier. Strict k-anonymity thresholds; no counterparty-identifiable pricing.

---

## ADR-023 — Scale architecture and multi-region readiness

**Status:** Proposed

**Decision.** Move remaining hot modules (Enquiry & Matching, Messaging) to services; adopt CDC-based read models for analytics; DR in a second India region; PA licence application decision (ADR-012 revisit) based on escrow volume. Keep all data in India.

---

## Appendix A — Decision dependency map

```
ADR-001 (hybrid, lead-first)
 ├─ ADR-002 (exclusive matching) ── needs ADR-008 (AI stack), ADR-007 (event log)
 ├─ ADR-003 (verification) ── needs ADR-010 (compliance)
 ├─ ADR-004 (vernacular onboarding) ── needs ADR-008
 ├─ ADR-005 (pricing) ── needs Billing module (ADR-006)
 └─ ADR-011 (vertical)
        │
Phase 2: ADR-012 (escrow) ── needs ADR-007 Order/Ledger, ADR-010
         ADR-013 (disputes) ── needs ADR-012, ADR-008
         ADR-014 (quote agent) ── needs ADR-008, ADR-002 data
         ADR-017 (ONDC adapter) ── needs ADR-007
        │
Phase 3: ADR-019 (credit) ── needs ADR-012 history, ADR-003 scores
         ADR-020 (agent-to-agent) ── needs ADR-014
         ADR-021 (ONDC live) ── needs ADR-013, ADR-017
         ADR-022 (price intel) ── needs ADR-012 volume
```

## Appendix B — Risks and mitigations

| Risk | Mitigation |
|---|---|
| Incumbent (IndiaMART) copies exclusive matching | Their revenue depends on lead volume per seller; exclusivity cannibalises ARPU — structural, not just technical |
| Alibaba/Amazon move agents into Indian SME lead-gen | Vernacular trust data + escrow disputes + India compliance are 12–24-month moats; move fast |
| Model-vendor cost/latency | Provider-agnostic orchestration (ADR-008); in-house small classifiers |
| Regulatory change (PA, DPDP, intermediary liability) | Partner-based escrow, consent ledger, proactive moderation |
| Seller onboarding friction from verification | Vernacular AI-guided flows; T0/T1 fast path |
| Small team over-engineering | Modular monolith; phase gates; explicit non-goals |

## Appendix C — Open questions for the DDR

1. Final vertical (ADR-011) and its language ordering.
2. Choice of Indian-language model vendor(s) and fallback.
3. PA partner shortlist and commercial terms.
4. Telephony/WhatsApp provider for reachability checks.
5. Embedding model and re-index strategy; pgvector vs dedicated store threshold.
6. Ledger design (double-entry) and reconciliation cadence with the PA.
7. Trust-score formula weights and decay parameters (to be tuned on Phase-1 data).
