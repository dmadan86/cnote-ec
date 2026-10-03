# ADR-044: Buyer-side modules: retention alerts, product Q&A and RFQ depth stay out of ranking and inside module boundaries

**Status:** Accepted (records decisions already implemented in PRs #23, #25, #31; design docs `docs/design/buyer-retention.md`, `docs/design/product-qa.md`, `docs/design/rfq-quotes.md`)
**Note:** Applies ADR-006 (module boundaries), ADR-002 (exclusive, capped matching), ADR-009 (ranking never from payment) and ADR-010 (DPDP) to new buyer features.

**Context.** Three buyer features landed together: follows, saved searches and opt-in alerts; public product questions and answers; and a deeper RFQ (budget, expiry, minimum supplier tier, drawings) with side-by-side quote comparison. Each needed a home in the module graph and a rule on how it interacts with ranking, matching and personal data.

**Options.**
1. Put everything in `enquiry` or `search`.
2. A new module per feature.
3. New module only where the feature has its own data and lifecycle; extend the existing owner where it reuses that owner's machinery.

**Decision.** Option 3.
- **`@cnote/alerts` is a new module** (follows, saved searches, alert settings, digests, price-drop and back-in-stock handlers). It reads saved items through `wishlist` and new matches through `search` public functions, decides what is new, and emits `BuyerAlertTriggered`; `@cnote/notifications` delivers (preferences, consent, signed one-click unsubscribe, `List-Unsubscribe`). Catalogue emits `ListingPriceChanged` v1 in the publish transaction. Everything is opt-in, jobs are idempotent (cursor compare-and-set, dispatch ledger), and **it never changes ranking**; the seller sees only an aggregate follower count. Export, erasure and retention are implemented.
- **Product Q&A is owned by `@cnote/reviews`** (`ProductQuestion`, `ProductAnswer`), not a new module, because it reuses the UGC pipeline: AI pre-screen, staff queue, reactions, reporter-credibility rules, erasure and retention, cache tags. A Q&A pair is public only when both the question and the answer are approved; contact details are stripped; FAQPage JSON-LD is emitted only for approved pairs. Events `ProductQuestionAsked`, `ProductQuestionAnswered` and `ProductQaModerated` are emitted in the same transaction.
- **RFQ depth is part of `enquiry`.** Budget range, quote expiry (default 7 days), a minimum supplier tier (a hard floor applied before ranking, so it filters but never reorders by payment), and up to five drawings in private media under `rfq/`. **Attachments are never sent to AI.** `EnquiryCreated` is bumped to v2 with optional fields. The buyer compares quotes in `getQuoteComparison`, shortlists, and `decideQuote` records an off-platform "won" at the server-computed total or a "lost"; sellers cannot accept after the buyer's deadline. The enquiry module gains a declared edge to `@cnote/media`.
- **Search filters and sort** (PR #18) extend the `@cnote/search` contract for both the Postgres and OpenSearch backends (tier, state/city, price range, MOQ, has-price, category with subcategories). Sort options never let plan or ad spend affect organic order; a property test and a pipeline test prove it. Pincode filtering is state-level only until delivery-area data exists, and is an explicit opt-in.
- **Buyer account.** The buyer's GSTIN is verified through the same GST provider port as sellers and gives the Business tier 1 (ADR-003); saved delivery addresses live in `identity` (`BusinessAddress`), with the state derived server-side from the PIN table. Erasure removes addresses and clears tax identifiers of sole-member non-seller businesses; seller tax identifiers are retained and documented.

**Rationale.**
- Reusing the reviews pipeline gives Q&A moderation, reporting limits and DPDP coverage on day one with no duplicated machinery.
- A separate alerts module keeps a notification-shaped feature out of `search` and `wishlist`, and the one-way flow (alerts decides, notifications delivers) keeps the dependency graph acyclic.
- Treating filters, tiers and sorts as retrieval constraints, not boosts, keeps ADR-009 intact.

**Consequences.**
- Native review of the six machine-drafted catalogues for these features is still open; only English and Hindi are live on the web.
- Attachments have type sniffing but no antivirus scan and no retention purge yet.
- Q&A is moderated asynchronously, so a new question is visible only to its asker until approved.
- The gaps against real procurement workflows (single-line RFQ, no PO document, no approvals) are listed honestly in `docs/adr/ADR-coverage.md`.

**Review.** When multi-line RFQ or buyer roles are scoped, and if alert volume or digest cost grows.
