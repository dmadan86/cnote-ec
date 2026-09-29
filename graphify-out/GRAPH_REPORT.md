# Graph Report - cnote  (2026-09-29)

## Corpus Check
- 454 files · ~201,481 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2772 nodes · 6812 edges · 198 communities (150 shown, 48 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 75 edges (avg confidence: 0.74)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `2093bf6a`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- ui/src/index.ts
- Alert
- billing/src/index.ts
- image.ts
- buttonClasses
- admin/src/lib/auth.ts
- dependencies
- lists.ts
- queue/index.ts
- Card
- site-header.tsx
- Button
- runAction
- ai/src/index.ts
- core/src/index.ts
- next-kit/package.json
- dependencies
- src/forms.tsx
- products/[id]/page.tsx
- scripts
- PHASE 1 — Trust-first lead marketplace (0–6 months)
- anthropic.ts
- steps.tsx
- requireSeller
- listings/actions.ts
- images.ts
- compilerOptions
- compilerOptions
- compilerOptions
- listings.ts
- search.ts
- seed.ts
- scripts
- reviews/src/index.ts
- identity/src/index.ts
- sessions.ts
- DomainError
- messaging.ts
- observability/src/index.ts
- app-shell.tsx
- (portal)/conversations/[id]/page.tsx
- ui/package.json
- extract.ts
- dependencies
- dependencies
- buyer.ts
- search/page.tsx
- section.tsx
- web/src/app/page.tsx
- catalogue/package.json
- src/auth.ts
- search/package.json
- next-kit/src/index.ts
- safeNext
- compare/actions.ts
- catalogue/src/index.ts
- emit
- wishlist/package.json
- ai/package.json
- submit.ts
- packages/admin/package.json
- ActionResult
- lead-card.tsx
- identity/package.json
- matching.ts
- otp.ts
- dependencies
- dependencies
- dependencies
- business.ts
- trust-worker.ts
- reviews/src/moderation.ts
- compilerOptions
- currentSession
- actorOf
- core/package.json
- billing/package.json
- enquiry/src/index.ts
- devDependencies
- next-kit/src/proxy.ts
- devDependencies
- devDependencies
- harness.ts
- intent.ts
- react.ts
- toVectorLiteral
- verification/actions.ts
- retrieval.ts
- scripts
- scripts
- scripts
- DESIGN.md
- registry.ts
- new-migration.ts
- billing/actions.ts
- identity/test/pure.test.ts
- media/package.json
- observability/package.json
- reviews.db.test.ts
- CLAUDE.md
- embedder.ts
- include
- shell.tsx
- include
- include
- include
- include
- include
- include
- include
- api/tsconfig.json
- image-manager.tsx
- countdown.tsx
- packages/admin/tsconfig.json
- catalogue/src/moderation.ts
- media/tsconfig.json
- next-kit/tsconfig.json
- observability/tsconfig.json
- reviews/tsconfig.json
- ui/tsconfig.json
- wishlist/tsconfig.json
- worker/tsconfig.json
- Seller onboarding research (Phase 1)
- summary.ts
- admin/src/app/layout.tsx
- admin/AGENTS.md
- admin/eslint.config.mjs
- admin/next.config.ts
- @cnote/catalogue
- @cnote/identity
- @cnote/next-kit
- @cnote/observability
- @cnote/reviews
- @cnote/ui
- lucide-react
- react
- react-dom
- @sentry/nextjs
- server-only
- admin/postcss.config.mjs
- seller/AGENTS.md
- seller/eslint.config.mjs
- seller/next.config.ts
- @cnote/billing
- @cnote/catalogue
- @cnote/core
- @cnote/identity
- @cnote/observability
- lucide-react
- next
- react
- server-only
- zod
- seller/postcss.config.mjs
- web/AGENTS.md
- web/eslint.config.mjs
- web/next.config.ts
- @cnote/catalogue
- @cnote/core
- @cnote/identity
- @cnote/media
- @cnote/observability
- @cnote/reviews
- @cnote/ui
- lucide-react
- next
- react
- server-only
- zod
- web/postcss.config.mjs
- prisma.config.ts
- search.test.ts
- app-shell.tsx
- hero.tsx
- google.ts
- no-access/page.tsx
- admin/src/proxy.ts

## God Nodes (most connected - your core abstractions)
1. `cn()` - 67 edges
2. `buttonClasses()` - 67 edges
3. `requireSeller()` - 57 edges
4. `Alert()` - 54 edges
5. `emit()` - 48 edges
6. `runAction()` - 42 edges
7. `Card()` - 39 edges
8. `CardBody()` - 39 edges
9. `DomainError` - 37 edges
10. `requireSession()` - 36 edges

## Surprising Connections (you probably didn't know these)
- `AccountPage()` --indirect_call--> `isRole()`  [INFERRED]
  apps/admin/src/app/(console)/account/page.tsx → packages/admin/src/rbac.ts
- `saveListingAction()` --indirect_call--> `listing()`  [INFERRED]
  apps/seller/src/features/listings/actions.ts → packages/wishlist/test/lists.db.test.ts
- `Outcome()` --calls--> `buttonClasses()`  [EXTRACTED]
  apps/seller/src/features/listings/listing-editor.tsx → packages/ui/src/components/button.tsx
- `Row()` --calls--> `cn()`  [EXTRACTED]
  apps/web/src/features/compare/compare-table.tsx → packages/ui/src/cn.ts
- `loadHits()` --indirect_call--> `listing()`  [INFERRED]
  apps/web/src/features/search/data.ts → packages/wishlist/test/lists.db.test.ts

## Import Cycles
- 2-file cycle: `packages/search/src/index.ts -> packages/search/src/search.ts -> packages/search/src/index.ts`
- 2-file cycle: `packages/catalogue/src/index.ts -> packages/catalogue/src/listings.ts -> packages/catalogue/src/index.ts`
- 2-file cycle: `packages/ai/src/index.ts -> packages/ai/src/types.ts -> packages/ai/src/index.ts`
- 3-file cycle: `packages/catalogue/src/index.ts -> packages/catalogue/src/reindex.ts -> packages/catalogue/src/mappers.ts -> packages/catalogue/src/index.ts`
- 3-file cycle: `packages/catalogue/src/index.ts -> packages/catalogue/src/reindex.ts -> packages/catalogue/src/validate.ts -> packages/catalogue/src/index.ts`
- 3-file cycle: `packages/catalogue/src/images.ts -> packages/catalogue/src/listings.ts -> packages/catalogue/src/index.ts -> packages/catalogue/src/images.ts`
- 3-file cycle: `packages/catalogue/src/images.ts -> packages/catalogue/src/mappers.ts -> packages/catalogue/src/index.ts -> packages/catalogue/src/images.ts`
- 3-file cycle: `packages/catalogue/src/categories.ts -> packages/catalogue/src/mappers.ts -> packages/catalogue/src/index.ts -> packages/catalogue/src/categories.ts`
- 3-file cycle: `packages/catalogue/src/index.ts -> packages/catalogue/src/listings.ts -> packages/catalogue/src/mappers.ts -> packages/catalogue/src/index.ts`
- 3-file cycle: `packages/catalogue/src/index.ts -> packages/catalogue/src/retrieval.ts -> packages/catalogue/src/mappers.ts -> packages/catalogue/src/index.ts`
- 3-file cycle: `packages/catalogue/src/index.ts -> packages/catalogue/src/listings.ts -> packages/catalogue/src/moderation.ts -> packages/catalogue/src/index.ts`
- 3-file cycle: `packages/catalogue/src/index.ts -> packages/catalogue/src/listings.ts -> packages/catalogue/src/validate.ts -> packages/catalogue/src/index.ts`
- 3-file cycle: `packages/ai/src/anthropic.ts -> packages/ai/src/index.ts -> packages/ai/src/registry.ts -> packages/ai/src/anthropic.ts`
- 3-file cycle: `packages/ai/src/heuristic/extract.ts -> packages/ai/src/index.ts -> packages/ai/src/registry.ts -> packages/ai/src/heuristic/extract.ts`
- 3-file cycle: `packages/ai/src/embedder.ts -> packages/ai/src/types.ts -> packages/ai/src/index.ts -> packages/ai/src/embedder.ts`
- 3-file cycle: `packages/ai/src/heuristic/intent.ts -> packages/ai/src/index.ts -> packages/ai/src/registry.ts -> packages/ai/src/heuristic/intent.ts`
- 3-file cycle: `packages/ai/src/heuristic/moderate.ts -> packages/ai/src/index.ts -> packages/ai/src/registry.ts -> packages/ai/src/heuristic/moderate.ts`
- 3-file cycle: `packages/ai/src/index.ts -> packages/ai/src/registry.ts -> packages/ai/src/types.ts -> packages/ai/src/index.ts`
- 3-file cycle: `packages/ai/src/decisions.ts -> packages/ai/src/types.ts -> packages/ai/src/index.ts -> packages/ai/src/decisions.ts`
- 4-file cycle: `packages/catalogue/src/images.ts -> packages/catalogue/src/listings.ts -> packages/catalogue/src/mappers.ts -> packages/catalogue/src/index.ts -> packages/catalogue/src/images.ts`

## Communities (198 total, 48 thin omitted)

### Community 0 - "ui/src/index.ts"
Cohesion: 0.11
Nodes (24): cn(), Avatar(), palette, Breadcrumbs(), Chip(), CompareToggle(), Field(), Label() (+16 more)

### Community 1 - "Alert"
Cohesion: 0.12
Nodes (41): AccountPage(), AuditPage(), metadata, BusinessDetailPage(), metadata, BusinessesPage(), metadata, href() (+33 more)

### Community 2 - "billing/src/index.ts"
Cohesion: 0.07
Nodes (59): metadata, PricingPage(), PROMISES, CreditCalculator(), recommendPlan(), ADR-0005, PlanCards(), modules (+51 more)

### Community 3 - "image.ts"
Cohesion: 0.06
Nodes (27): biz, staffId, tag, ascii(), Dimensions, IMAGE_EXT, ImageMime, ImageValidationError (+19 more)

### Community 4 - "buttonClasses"
Cohesion: 0.08
Nodes (47): metadata, OnboardingPage(), LandingPage(), STEPS, VALUE, BillingPage(), metadata, REASON (+39 more)

### Community 5 - "admin/src/lib/auth.ts"
Cohesion: 0.09
Nodes (48): resolveReviewAction(), schema, deactivateStaffAction(), grantStaffAction(), personId, roles(), updateRolesAction(), bulkApproveImagesAction() (+40 more)

### Community 6 - "dependencies"
Cohesion: 0.05
Nodes (43): dependencies, @cnote/billing, @cnote/catalogue, @cnote/core, @cnote/db, @cnote/enquiry, @cnote/identity, @cnote/observability (+35 more)

### Community 7 - "lists.ts"
Cohesion: 0.08
Nodes (65): metadata, WishlistPage(), createBuyerBusinessAction(), deleteAccountAction(), requestOtpAction(), updateProfileAction(), verifyOtpAction(), CONSENT_COPY (+57 more)

### Community 8 - "queue/index.ts"
Cohesion: 0.05
Nodes (37): ADR-0023, consumeOnce(), EventHandler, relayOutbox(), DomainEvent, DomainEventPayloads, DomainEventType, EVENT_VERSIONS (+29 more)

### Community 9 - "Card"
Cohesion: 0.15
Nodes (12): date, metadata, ENQUIRY, EnquiryStatusBadge(), enquiryStatusLabel(), MATCH, MatchStatusBadge(), BadgeTone (+4 more)

### Community 10 - "site-header.tsx"
Cohesion: 0.11
Nodes (19): geistSans, metadata, viewport, Analytics(), AccountMenu(), MobileMenu(), NavMenus(), PincodePicker() (+11 more)

### Community 11 - "Button"
Cohesion: 0.14
Nodes (12): RfqFormProps, UNITS, RfqResult(), LABELS, StarInput(), SubmitButton(), ButtonProps, ButtonSize (+4 more)

### Community 12 - "runAction"
Cohesion: 0.14
Nodes (19): ImageDetailPage(), metadata, STATUS_TONE, href(), ImagesPage(), kb(), metadata, STATUSES (+11 more)

### Community 13 - "ai/src/index.ts"
Cohesion: 0.10
Nodes (31): Capability, include, json(), listOpenReviewsImpl(), purgeOldDecisionInputs(), resolveReviewImpl(), REVIEW_THRESHOLDS, ReviewRow (+23 more)

### Community 14 - "core/src/index.ts"
Cohesion: 0.14
Nodes (20): createBusinessAction(), finishOnboardingAction(), OtpSent, phoneSchema, requestOtpAction(), skipStepAction(), ADR-0003, ADR-0005 (+12 more)

### Community 15 - "next-kit/package.json"
Cohesion: 0.06
Nodes (35): dependencies, @cnote/core, @cnote/identity, @cnote/ui, server-only, zod, devDependencies, next (+27 more)

### Community 16 - "dependencies"
Cohesion: 0.06
Nodes (34): dependencies, @cnote/ai, @cnote/billing, @cnote/catalogue, @cnote/core, @cnote/db, @cnote/enquiry, @cnote/identity (+26 more)

### Community 17 - "src/forms.tsx"
Cohesion: 0.10
Nodes (19): metadata, metadata, SignInPage(), safeNext(), metadata, metadata, metadata, metadata (+11 more)

### Community 18 - "products/[id]/page.tsx"
Cohesion: 0.26
Nodes (16): CategoryPage(), generateMetadata(), generateMetadata(), ManufacturerPage(), TIER, generateMetadata(), prettify(), ProductPage() (+8 more)

### Community 19 - "scripts"
Cohesion: 0.06
Nodes (33): devDependencies, dotenv, tsx, @types/node, typescript, vitest, engines, node (+25 more)

### Community 20 - "PHASE 1 — Trust-first lead marketplace (0–6 months)"
Cohesion: 0.06
Nodes (32): 0. How to read this document, ADR-000 — Problem statement and decision drivers, ADR-001 — Business model: hybrid, lead-first, ADR-002 — Lead product: AI intent-scored, exclusive (capped) matching, ADR-003 — Seller verification: tiered, API-driven, continuous, ADR-004 — Seller onboarding and catalogue: vernacular, voice-first, WhatsApp-native, catalogue-from-photo, ADR-005 — Pricing: transparent, self-serve, success-aligned, ADR-006 — Core platform architecture: modular monolith, service-ready boundaries (+24 more)

### Community 21 - "anthropic.ts"
Cohesion: 0.11
Nodes (26): IntentCase, AnthropicIntentScorer, AnthropicListingExtractor, AnthropicModerator, callJson(), clamp01(), createAnthropicClient(), ExtractSchema (+18 more)

### Community 22 - "steps.tsx"
Cohesion: 0.15
Nodes (23): sendMessageAction(), DealReportForm(), MessageForm(), QuoteForm(), draftListingAction(), AiDraftBox(), EXAMPLES, ListingEditor() (+15 more)

### Community 23 - "requireSeller"
Cohesion: 0.24
Nodes (11): deleteImageAction(), reorderImagesAction(), setAltTextAction(), uuid, fields, replyAction(), ReplyResult, ADR-0008 (+3 more)

### Community 24 - "listings/actions.ts"
Cohesion: 0.15
Nodes (18): archiveListingAction(), DraftResult, draftSchema, formSchema, issue(), publishListingAction(), RowResult, saveListingAction() (+10 more)

### Community 25 - "images.ts"
Cohesion: 0.14
Nodes (28): GET(), cleanAlt(), deleteListingImage(), getListingForSeller(), ImageModerationItem, ImageRow, ImageStatus, ImageViewer (+20 more)

### Community 26 - "compilerOptions"
Cohesion: 0.07
Nodes (28): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+20 more)

### Community 27 - "compilerOptions"
Cohesion: 0.07
Nodes (28): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+20 more)

### Community 28 - "compilerOptions"
Cohesion: 0.07
Nodes (28): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+20 more)

### Community 29 - "listings.ts"
Cohesion: 0.15
Nodes (27): ListingInput, archiveListing(), attrsOf(), CONTENT_KEYS, createListing(), draftListingFromText(), listSellerListings(), loadOwned() (+19 more)

### Community 30 - "search.ts"
Cohesion: 0.16
Nodes (19): getCategoryBySlug(), getListingsByIds(), listFeaturedListings(), Candidate, locationBoost(), rrfFuse(), trustFactor(), ADR-0009 (+11 more)

### Community 31 - "seed.ts"
Cohesion: 0.12
Nodes (25): Cat, CATS, City, CLEAN, cleanSeed(), embed(), Field, gstinCheckChar() (+17 more)

### Community 32 - "scripts"
Cohesion: 0.07
Nodes (26): dependencies, pg, @prisma/adapter-pg, @prisma/client, devDependencies, dotenv, @types/pg, exports (+18 more)

### Community 33 - "reviews/src/index.ts"
Cohesion: 0.21
Nodes (12): first(), metadata, replyTone, ReviewsPage(), isTombstone(), authorNames(), listApprovedComments(), listApprovedReviews() (+4 more)

### Community 34 - "identity/src/index.ts"
Cohesion: 0.13
Nodes (24): AccountPage(), onboardingSchema, saveConsentsAction(), signOutEverywhereAction(), ADR-0007, SignUpInput, updateProfile(), getConsents() (+16 more)

### Community 35 - "sessions.ts"
Cohesion: 0.30
Nodes (14): cacheState(), getSession(), issueTokens(), mint(), refreshSession(), revokeById(), sessionActive(), sessKey() (+6 more)

### Community 36 - "DomainError"
Cohesion: 0.31
Nodes (12): errorResponse(), clearAuthCookies(), authRoute(), ctxOf(), eq(), googleCallback(), googleStart(), redirectTo() (+4 more)

### Community 37 - "messaging.ts"
Cohesion: 0.13
Nodes (21): emit(), rateLimit(), createEnquiry(), getConversation(), Loaded, loadForActor(), requireParticipant(), sendMessage() (+13 more)

### Community 38 - "observability/src/index.ts"
Cohesion: 0.13
Nodes (16): ADR-0010, register(), ADR-0010, register(), ADR-0010, register(), AppName, num() (+8 more)

### Community 39 - "app-shell.tsx"
Cohesion: 0.20
Nodes (4): geistSans, metadata, viewport, Logo()

### Community 40 - "(portal)/conversations/[id]/page.tsx"
Cohesion: 0.19
Nodes (10): ConvResult, quoteSchema, reportDealAction(), sendQuoteAction(), ADR-0007, formatINR(), inr, Paise (+2 more)

### Community 41 - "ui/package.json"
Cohesion: 0.09
Nodes (23): clsx, dependencies, clsx, lucide-react, tailwind-merge, devDependencies, react, @types/react (+15 more)

### Community 42 - "extract.ts"
Cohesion: 0.16
Nodes (22): esc(), extractAttributes(), extractListingHeuristic(), Field, MOQ_RE, namesOf(), NUM, parsePrice() (+14 more)

### Community 43 - "dependencies"
Cohesion: 0.08
Nodes (23): dependencies, @cnote/ai, @cnote/billing, @cnote/catalogue, @cnote/core, @cnote/db, @cnote/identity, zod (+15 more)

### Community 44 - "dependencies"
Cohesion: 0.08
Nodes (23): dependencies, @cnote/ai, @cnote/catalogue, @cnote/core, @cnote/db, @cnote/enquiry, @cnote/identity, zod (+15 more)

### Community 45 - "buyer.ts"
Cohesion: 0.25
Nodes (8): DbClient, globalForPrisma, Tx, toViews(), categories(), enquiryBase(), matchView(), strArr()

### Community 46 - "search/page.tsx"
Cohesion: 0.13
Nodes (21): ComingSoonPage(), FEATURES, ManufacturersPage(), metadata, COMING, generateMetadata(), href(), NoResults() (+13 more)

### Community 47 - "section.tsx"
Cohesion: 0.15
Nodes (18): date(), ReviewCard(), CommentItem(), date(), EMPTY_SUMMARY(), isSort(), ProductReviewsSection(), soft() (+10 more)

### Community 48 - "web/src/app/page.tsx"
Cohesion: 0.14
Nodes (18): CategoriesPage(), metadata, FALLBACK_SUGGESTIONS, Home(), CategoryIcon(), ICONS, loadCategories(), loadSuggestions() (+10 more)

### Community 49 - "catalogue/package.json"
Cohesion: 0.09
Nodes (21): dependencies, @cnote/ai, @cnote/core, @cnote/db, @cnote/identity, @cnote/media, zod, exports (+13 more)

### Community 50 - "src/auth.ts"
Cohesion: 0.14
Nodes (25): emailSchema, INVALID(), ipKey(), nameSchema, requestPasswordReset(), resetKey(), resetPassword(), signInWithPassword() (+17 more)

### Community 51 - "search/package.json"
Cohesion: 0.09
Nodes (21): dependencies, @cnote/ai, @cnote/catalogue, @cnote/core, @cnote/db, @cnote/identity, zod, exports (+13 more)

### Community 52 - "next-kit/src/index.ts"
Cohesion: 0.21
Nodes (10): ErrorCode, HTTP_STATUS, forgotPasswordAction(), signInAction(), signOutAction(), signUpAction(), ADR-0010, requestContext() (+2 more)

### Community 53 - "safeNext"
Cohesion: 0.19
Nodes (14): metadata, metadata, ResetPasswordPage(), metadata, SignInPage(), metadata, SignUpPage(), metadata (+6 more)

### Community 54 - "compare/actions.ts"
Cohesion: 0.12
Nodes (31): ComparePage(), metadata, clearCompareAction(), readTray(), removeFromCompareAction(), toggleCompareAction(), writeTray(), attrText() (+23 more)

### Community 55 - "catalogue/src/index.ts"
Cohesion: 0.19
Nodes (16): first(), metadata, NewRfqPage(), RfqForm(), CategoryDef, getCategoryById(), listCategories(), upsertCategories() (+8 more)

### Community 56 - "emit"
Cohesion: 0.19
Nodes (18): acceptLead(), closeOffer(), declineLead(), expireOverdueOffers(), getSellerLead(), listSellerLeads(), refundMatch(), repairCascades() (+10 more)

### Community 57 - "wishlist/package.json"
Cohesion: 0.10
Nodes (19): dependencies, @cnote/catalogue, @cnote/core, @cnote/db, @cnote/identity, zod, exports, @cnote/catalogue (+11 more)

### Community 58 - "ai/package.json"
Cohesion: 0.11
Nodes (18): @anthropic-ai/sdk, dependencies, @anthropic-ai/sdk, @cnote/core, @cnote/db, zod, exports, @cnote/core (+10 more)

### Community 59 - "submit.ts"
Cohesion: 0.24
Nodes (15): authorStatus(), Screen, screenText(), ADR-0008, isSellerSide(), isUniqueViolation(), limit(), publishedListing() (+7 more)

### Community 60 - "packages/admin/package.json"
Cohesion: 0.11
Nodes (18): dependencies, @cnote/core, @cnote/db, zod, exports, @cnote/core, @cnote/db, zod (+10 more)

### Community 61 - "ActionResult"
Cohesion: 0.50
Nodes (4): moderateAction(), schema, moderate(), snap()

### Community 62 - "lead-card.tsx"
Cohesion: 0.23
Nodes (14): acceptLeadAction(), DECLINE_REASONS, declineLeadAction(), LeadResult, matchIdSchema, refresh(), reportBuyerProblemAction(), ADR-0002 (+6 more)

### Community 63 - "identity/package.json"
Cohesion: 0.11
Nodes (17): jose, dependencies, @cnote/core, @cnote/db, jose, zod, exports, @cnote/core (+9 more)

### Community 64 - "matching.ts"
Cohesion: 0.17
Nodes (20): cascade(), leadCapFor(), loadEmbedding(), offerMatches(), rankedCandidates(), runMatching(), ADR-0002, assignSlots() (+12 more)

### Community 65 - "otp.ts"
Cohesion: 0.18
Nodes (13): consoleMailer, consoleSms, getSmsSender(), Mailer, setMailer(), setSmsSender(), SmsSender, digest() (+5 more)

### Community 66 - "dependencies"
Cohesion: 0.12
Nodes (17): dependencies, @cnote/admin, @cnote/ai, @cnote/billing, @cnote/core, @cnote/enquiry, @cnote/media, next (+9 more)

### Community 67 - "dependencies"
Cohesion: 0.12
Nodes (17): dependencies, @cnote/ai, @cnote/enquiry, @cnote/media, @cnote/next-kit, @cnote/reviews, @cnote/ui, react-dom (+9 more)

### Community 68 - "dependencies"
Cohesion: 0.12
Nodes (17): dependencies, @cnote/ai, @cnote/billing, @cnote/enquiry, @cnote/next-kit, @cnote/search, @cnote/wishlist, react-dom (+9 more)

### Community 69 - "business.ts"
Cohesion: 0.22
Nodes (12): createSchema, verifyGstin(), getGstnProvider(), GST_STATES, gstinCheckChar(), GstnProvider, GstnRecord, isValidGstin() (+4 more)

### Community 70 - "trust-worker.ts"
Cohesion: 0.16
Nodes (17): EventHandlers, ModuleWorker, createBusiness(), computeTrustScore(), emptySignals(), TIER_POINTS, TrustSignals, ADR-0002 (+9 more)

### Community 71 - "reviews/src/moderation.ts"
Cohesion: 0.14
Nodes (25): Histogram(), ADR-0003, ADR-0008, ADR-0010, commentItem(), CommentRow, getModerationItem(), listModerationQueue() (+17 more)

### Community 72 - "compilerOptions"
Cohesion: 0.12
Nodes (16): compilerOptions, esModuleInterop, isolatedModules, jsx, lib, module, moduleResolution, noEmit (+8 more)

### Community 73 - "currentSession"
Cohesion: 0.18
Nodes (11): actor(), reactAction(), SIGN_IN, submitCommentAction(), submitReviewAction(), uuid, CommentForm(), ReactionButtons() (+3 more)

### Community 74 - "actorOf"
Cohesion: 0.16
Nodes (18): EnquiryDetailPage(), ConversationPage(), metadata, num(), pickSellersAction(), postRfqAction(), reportDealAction(), sendMessageAction() (+10 more)

### Community 75 - "core/package.json"
Cohesion: 0.12
Nodes (15): ioredis, dependencies, @cnote/db, ioredis, zod, exports, @cnote/db, zod (+7 more)

### Community 76 - "billing/package.json"
Cohesion: 0.12
Nodes (15): dependencies, @cnote/core, @cnote/db, zod, exports, @cnote/core, @cnote/db, zod (+7 more)

### Community 77 - "enquiry/src/index.ts"
Cohesion: 0.15
Nodes (21): BuyerEnquiriesPage(), DomainError, include, listBuyerEnquiries(), listCandidatesForBuyer(), ownedEnquiry(), Row, ADR-0002 (+13 more)

### Community 78 - "devDependencies"
Cohesion: 0.13
Nodes (15): devDependencies, eslint, eslint-config-next, tailwindcss, @tailwindcss/postcss, @types/node, @types/react, @types/react-dom (+7 more)

### Community 79 - "next-kit/src/proxy.ts"
Cohesion: 0.18
Nodes (12): config, proxy, config, proxy, accessCookie(), base(), CookieWriter, jwtExp() (+4 more)

### Community 80 - "devDependencies"
Cohesion: 0.13
Nodes (15): devDependencies, eslint, eslint-config-next, tailwindcss, @tailwindcss/postcss, @types/node, @types/react, @types/react-dom (+7 more)

### Community 81 - "devDependencies"
Cohesion: 0.13
Nodes (15): devDependencies, eslint, eslint-config-next, tailwindcss, @tailwindcss/postcss, @types/node, @types/react, @types/react-dom (+7 more)

### Community 82 - "harness.ts"
Cohesion: 0.14
Nodes (13): EvalReport, ExtractCase, Metric, ModCase, runEvals(), THRESHOLDS, Triplet, ADR-0008 (+5 more)

### Community 83 - "intent.ts"
Cohesion: 0.20
Nodes (12): allCaps(), gibberishRatio(), scoreIntentHeuristic(), SPEC_PATTERNS, specMatches(), ADR-0002, firstMatch(), moderateHeuristic() (+4 more)

### Community 84 - "react.ts"
Cohesion: 0.16
Nodes (13): isUniqueViolation(), react(), ReactInput, ReactionKind, Actor, CommentInput, noContactInfo(), replyInput (+5 more)

### Community 85 - "toVectorLiteral"
Cohesion: 0.23
Nodes (10): reindex(), reindexEmbeddings(), reindexStaleEmbeddings(), canonicalText(), biz, listings, seedListing(), tag (+2 more)

### Community 86 - "verification/actions.ts"
Cohesion: 0.38
Nodes (9): GstResult, ADR-0003, verifyGstinAction(), GstForm(), checkGstin(), GstinCheck, gstinChecksumChar(), normalizeGstin() (+1 more)

### Community 87 - "retrieval.ts"
Cohesion: 0.25
Nodes (12): resolveListingModeration(), isUuid(), filters(), findSellerCandidates(), lexical(), LIVE, retrieveListings(), tokens() (+4 more)

### Community 88 - "scripts"
Cohesion: 0.18
Nodes (10): name, private, scripts, build, dev, lint, start, test (+2 more)

### Community 89 - "scripts"
Cohesion: 0.18
Nodes (10): name, private, scripts, build, dev, lint, start, test (+2 more)

### Community 90 - "scripts"
Cohesion: 0.18
Nodes (10): name, private, scripts, build, dev, lint, start, test (+2 more)

### Community 91 - "DESIGN.md"
Cohesion: 0.18
Nodes (9): Accessibility and performance, Content and language, Domain components and their rules, Home page anatomy (matches the reference), Imagery, Primitives (`@cnote/ui`), Principles, States and feedback (+1 more)

### Community 92 - "registry.ts"
Cohesion: 0.17
Nodes (12): metadata, OnboardingDonePage(), PortalLayout(), LeadsPage(), metadata, EditListingPage(), metadata, metadata (+4 more)

### Community 93 - "new-migration.ts"
Cohesion: 0.24
Nodes (8): dir, raw, sql, stamp, FORBIDDEN, MIGRATIONS, strip(), violations()

### Community 94 - "billing/actions.ts"
Cohesion: 0.36
Nodes (8): BillingResult, cancelPlanAction(), refresh(), subscribeAction(), ADR-0005, CancelPlan(), SubscribeButton(), ADR-0005

### Community 95 - "identity/test/pure.test.ts"
Cohesion: 0.29
Nodes (9): Clarity(), ClarityFn, Window, AnalyticsConsent, ConsentBanner(), ManageConsentLink(), readConsent(), ADR-0010 (+1 more)

### Community 96 - "media/package.json"
Cohesion: 0.20
Nodes (9): dependencies, exports, name, private, scripts, test, typecheck, type (+1 more)

### Community 97 - "observability/package.json"
Cohesion: 0.20
Nodes (9): dependencies, exports, name, private, scripts, test, typecheck, type (+1 more)

### Community 98 - "reviews.db.test.ts"
Cohesion: 0.14
Nodes (10): anonymisePerson(), tombstoneForReview(), ADR-0010, worker, good, listingIds, people, sellerBiz (+2 more)

### Community 99 - "CLAUDE.md"
Cohesion: 0.25
Nodes (6): Architecture rules, Commands, Non-goals, Stack and layout, UI reference, What this is

### Community 100 - "embedder.ts"
Cohesion: 0.36
Nodes (6): add(), embedText(), hash32(), localEmbedder, ADR-0008, Embedder

### Community 101 - "include"
Cohesion: 0.25
Nodes (7): extends, include, src, test, *.ts, ../../tsconfig.base.json, evals

### Community 102 - "shell.tsx"
Cohesion: 0.38
Nodes (4): ConsoleLayout(), NavLink(), NAV, Shell()

### Community 103 - "include"
Cohesion: 0.29
Nodes (6): extends, include, src, test, *.ts, ../../tsconfig.base.json

### Community 104 - "include"
Cohesion: 0.29
Nodes (6): extends, include, src, test, *.ts, ../../tsconfig.base.json

### Community 105 - "include"
Cohesion: 0.29
Nodes (6): extends, include, src, test, *.ts, ../../tsconfig.base.json

### Community 106 - "include"
Cohesion: 0.29
Nodes (6): extends, include, src, *.ts, ../../tsconfig.base.json, prisma

### Community 107 - "include"
Cohesion: 0.29
Nodes (6): extends, include, src, test, *.ts, ../../tsconfig.base.json

### Community 108 - "include"
Cohesion: 0.29
Nodes (6): extends, include, src, test, *.ts, ../../tsconfig.base.json

### Community 109 - "include"
Cohesion: 0.29
Nodes (6): extends, include, src, test, *.ts, ../../tsconfig.base.json

### Community 110 - "api/tsconfig.json"
Cohesion: 0.33
Nodes (5): extends, include, src, test, ../../tsconfig.base.json

### Community 111 - "image-manager.tsx"
Cohesion: 0.27
Nodes (8): COPY, metadata, ImageManager(), STATUS, TYPES, Upload, uploadOne(), STEPS

### Community 112 - "countdown.tsx"
Cohesion: 0.53
Nodes (5): Countdown(), format(), nowSeconds(), subscribe(), ADR-0002

### Community 113 - "packages/admin/tsconfig.json"
Cohesion: 0.33
Nodes (5): extends, include, src, test, ../../tsconfig.base.json

### Community 114 - "catalogue/src/moderation.ts"
Cohesion: 0.33
Nodes (5): Assessment, Content, ADR-0003, ADR-0004, ADR-0008

### Community 115 - "media/tsconfig.json"
Cohesion: 0.33
Nodes (5): extends, include, src, test, ../../tsconfig.base.json

### Community 116 - "next-kit/tsconfig.json"
Cohesion: 0.33
Nodes (5): extends, include, src, test, ../../tsconfig.base.json

### Community 117 - "observability/tsconfig.json"
Cohesion: 0.33
Nodes (5): extends, include, src, test, ../../tsconfig.base.json

### Community 118 - "reviews/tsconfig.json"
Cohesion: 0.33
Nodes (5): extends, include, src, test, ../../tsconfig.base.json

### Community 119 - "ui/tsconfig.json"
Cohesion: 0.33
Nodes (5): extends, include, src, test, ../../tsconfig.base.json

### Community 120 - "wishlist/tsconfig.json"
Cohesion: 0.33
Nodes (5): extends, include, src, test, ../../tsconfig.base.json

### Community 121 - "worker/tsconfig.json"
Cohesion: 0.40
Nodes (4): extends, include, src, ../../tsconfig.base.json

### Community 122 - "Seller onboarding research (Phase 1)"
Cohesion: 0.40
Nodes (4): Design decisions for apps/seller, Findings, Seller onboarding research (Phase 1), Sources

### Community 123 - "summary.ts"
Cohesion: 0.29
Nodes (6): POST(), GET(), GET(), ADR-0010, exportPersonalData(), currentSession

### Community 193 - "app-shell.tsx"
Cohesion: 0.36
Nodes (5): BottomNav(), NAV_ITEMS, NavItem, SidebarNav(), useActive()

### Community 194 - "hero.tsx"
Cohesion: 0.31
Nodes (6): SearchCard(), TABS, Hero(), TICKS, VALUE_CARDS, HeroVisual()

### Community 195 - "google.ts"
Cohesion: 0.33
Nodes (7): completeGoogleSignIn(), creds(), googleAuthorizationUrl(), GoogleClaims, ISSUERS, upsertGoogleUser(), verifyGoogleIdToken()

### Community 196 - "no-access/page.tsx"
Cohesion: 0.36
Nodes (6): metadata, ResetPasswordPage(), metadata, NoAccessPage(), one(), getStaff()

### Community 197 - "admin/src/proxy.ts"
Cohesion: 0.53
Nodes (5): authProxy, config, harden(), proxy(), PUBLIC_PATHS

## Knowledge Gaps
- **947 isolated node(s):** `eslintConfig`, `nextConfig`, `name`, `version`, `private` (+942 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **48 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `buttonClasses()` connect `search/page.tsx` to `ui/src/index.ts`, `identity/src/index.ts`, `hero.tsx`, `buttonClasses`, `lists.ts`, `Card`, `site-header.tsx`, `Button`, `enquiry/src/index.ts`, `section.tsx`, `web/src/app/page.tsx`, `src/forms.tsx`, `products/[id]/page.tsx`, `steps.tsx`, `compare/actions.ts`, `registry.ts`, `lead-card.tsx`?**
  _High betweenness centrality (0.020) - this node is a cross-community bridge._
- **Why does `DomainError` connect `enquiry/src/index.ts` to `Alert`, `billing/src/index.ts`, `admin/src/lib/auth.ts`, `lists.ts`, `ai/src/index.ts`, `listings/actions.ts`, `images.ts`, `listings.ts`, `identity/src/index.ts`, `sessions.ts`, `DomainError`, `messaging.ts`, `src/auth.ts`, `next-kit/src/index.ts`, `emit`, `submit.ts`, `matching.ts`, `otp.ts`, `google.ts`, `business.ts`, `reviews/src/moderation.ts`, `next-kit/src/proxy.ts`, `react.ts`, `summary.ts`?**
  _High betweenness centrality (0.013) - this node is a cross-community bridge._
- **Why does `Alert()` connect `buttonClasses` to `ui/src/index.ts`, `Alert`, `admin/src/lib/auth.ts`, `lists.ts`, `Button`, `runAction`, `core/src/index.ts`, `src/forms.tsx`, `steps.tsx`, `listings/actions.ts`, `reviews/src/index.ts`, `search/page.tsx`, `section.tsx`, `safeNext`, `lead-card.tsx`, `no-access/page.tsx`, `actorOf`, `verification/actions.ts`, `registry.ts`, `billing/actions.ts`, `image-manager.tsx`?**
  _High betweenness centrality (0.009) - this node is a cross-community bridge._
- **What connects `eslintConfig`, `nextConfig`, `name` to the rest of the system?**
  _947 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `ui/src/index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11295681063122924 - nodes in this community are weakly interconnected._
- **Should `Alert` be split into smaller, more focused modules?**
  _Cohesion score 0.11986531986531987 - nodes in this community are weakly interconnected._
- **Should `billing/src/index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07198748043818466 - nodes in this community are weakly interconnected._