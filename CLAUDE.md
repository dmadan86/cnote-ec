# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An AI-first B2B marketplace for Indian MSMEs, positioned against IndiaMART's broadcast-lead model. The working name is TBD; "BizKart" in the design reference is a placeholder. The source of truth for product and architecture decisions is `docs/adr/ADR-v0.1.md`. Read the relevant ADR before building a feature, and cite it (e.g. "per ADR-002") in PRs and non-obvious code.

**Current phase: Phase 1** (trust-first lead marketplace, one vertical). Phase 2 modules are **built but flagged off** (`@cnote/escrow`, `disputes`, `negotiation`, `quality`, `verticals`, `ondc`; flags in `.env.example`, status in `docs/adr/ADR-coverage.md`). Phase 3 modules are also built and flagged off (`@cnote/credit`, `a2a`, `prices`, ONDC live; plus `apps/ai-service`, `apps/search-service`, `@cnote/analytics` for ADR-018/023). The Phase-1 vertical (ADR-011) is still undecided, so category-specific logic must be config and data, not hardcoded.

## Stack and layout

pnpm monorepo (Node ≥ 22). Internal packages ship TypeScript source (no build step); `apps/web` transpiles them via `transpilePackages`.

- `apps/web`: buyer marketplace (port 3000). `apps/seller`: seller onboarding + seller portal (port 3002). `apps/admin`: back office (port 3001). `apps/studio`: storefront + template studio (port 3004, seller realm on its own host). All four are Next.js 16 App Router apps, **deployed separately** (separate hosts, so auth cookies are host-scoped per app). **Next 16 has breaking changes vs. older docs** (async `cookies()`/`params`, `middleware` → `proxy.ts`, etc.). Read `apps/web/AGENTS.md` and `node_modules/next/dist/docs/` before writing Next code.
- `apps/api`: public REST API (`/v1`, OpenAPI at `/openapi.json` for Apidog) + MCP server (`/mcp`), Hono on Node, port 3003, separately hosted. Authenticated by personal API keys (`@cnote/developer`: scoped per feature, expiry 1d/7d/30d/90d/1y/never, only the sha256 is stored). Docs in `docs/api/`.
- `apps/worker`: runs the outbox relay, each module's event handlers (observers), work-queue consumers and scheduled jobs. **It is required, not optional**: account emails (password reset, "someone tried to register with your email", DPDP request confirmations) go through the `identity.mail` queue (`packages/identity/src/mail-queue.ts`) and are only sent when a worker consumes it. Run one worker per region.
- `packages/db`: Prisma 7 (driver adapter `@prisma/adapter-pg`) with a **multi-file schema, one file per module** in `prisma/schema/`. It also has migrations and the generated client (gitignored, created by `postinstall`).
- `packages/core`: shared kernel: domain event catalogue + `emit()`, the **transport factories** (`getEventTransport()` for pub/sub domain events, `getJobQueue()` for work queues with retries/backoff/dead letters; driver chosen by `QUEUE_DRIVER=redis|memory|kafka`, Kafka stubbed), Redis (`cached`, `rateLimit`), money (paise), `DomainError`, and `ModuleWorker` (`handlers` for events, `queues` for job topics, `jobs` for schedules). Job topics are typed by declaration-merging `JobTopics`.
- `packages/templates` + `packages/email` + `packages/notifications`: email/notification content lives in the **database** and is edited in the admin template studio (rich text, images, layouts with header/footer, versions, publish/rollback). Code only registers template keys + variables + defaults (`defineTemplates`). Never hard-code user-facing email/notification copy in the sending path. Notifications observe domain events and fan out through the job queue, honouring preferences and marketing consent.
- `packages/metrics` (ADR success metrics from the event log, SLO alerts), `packages/compliance` (DPDP: retention registry calling each module's own purge function, grievances, appeals, residency guard), `packages/whatsapp` (WhatsApp Cloud API channel + onboarding state machine), `packages/bulk`, `packages/leadgen`, `packages/storefront`, `packages/domains`, `packages/live-db` (CQRS read DB), `packages/security`, `packages/media`: see each `src/index.ts` and `docs/design/`.
- **i18n (seller app):** cookie locale (`seller_locale`), catalogues in `apps/seller/messages/<locale>[.<ns>].json` (8 locales, parity test in `apps/seller/test/i18n.test.ts`), register new namespaces in `src/i18n/messages.ts`; format numbers/dates with `intlTag(locale)` from `@/i18n/config`.
- **i18n (buyer web):** `apps/web/messages/*.json` (next-intl); public pages live under `app/[locale]/` and stay static; `/` is English, `/hi/...` Hindi. Only `en` and `hi` are enabled on the web (`LOCALES` in `apps/web/src/i18n/config.ts`, ADR-004); the other catalogues stay on disk (`ALL_LOCALES`, still parity-tested) and re-enabling one is adding its code to `LOCALES`; disabled prefixes like `/kn/...` redirect to English. Every new user-facing web string goes into `en.json` AND `hi.json` (a test enforces key parity). See `docs/guides/i18n.md`.
- `packages/observability`: SDK-free Sentry options with DPDP-safe PII scrubbing; every app/worker calls `Sentry.init(sentryOptions(app, runtime))`. No-op without a DSN. Microsoft Clarity runs on the buyer web only, after analytics consent. **Cookie consent:** every non-essential cookie/storage key must be in the app's registry (`apps/web/src/features/consent/registry.ts`, `apps/seller/src/features/consent/registry.ts`; a test enforces it) and gated on that app's consent cookie (`cnote_consent`, `seller_consent`; banner + preferences dialog from `@cnote/next-kit/consent`, core in `@cnote/consent`, receipts via `POST /api/consent` with an `app` column, DPDP s.6). Admin and studio have only strictly necessary storage (registry + test, no banner). Third-party iframes must sit inside `<ConsentGate>` (a test enforces it); see `docs/design/cookie-consent.md`.
- `packages/ui`: shared React UI library plus design tokens. See `DESIGN.md`.
- `packages/next-kit`: Next.js glue shared by the apps: cookie sessions over `@cnote/identity`, `authRoute` (mount at `src/app/api/auth/[action]/route.ts`), `createAuthProxy` (`src/proxy.ts`), auth server actions and client forms, and `runAction`/`errorResponse`. Each app's pages stay thin: they compose module functions and `@cnote/ui`.
- `packages/admin`: staff RBAC (roles → privileges defined in code in `rbac.ts`) and the append-only `AdminAuditLog`. Every admin mutation goes through `audited()`. Grant access with `pnpm admin:grant <email> <role...>`.
- `packages/consent` (`@cnote/consent`): framework-free cookie-consent core shared by every app (consent record, registry types, GPC, receipt outbox, policy snapshots, `./testing` scanners). Depends on nothing; the React UI is `@cnote/next-kit/consent`, receipts are written by `@cnote/compliance`. See `docs/design/cookie-consent.md`.
- `packages/alerts` (`@cnote/alerts`): buyer retention: followed suppliers, saved searches, opt-in alerts and digests. It decides what is new and emits `BuyerAlertTriggered`; `@cnote/notifications` delivers. It never touches ranking. See `docs/design/buyer-retention.md`.
- Also present: `packages/reviews` (reviews + product Q&A, UGC moderation), `wishlist` (lists, shared links), `promotions` (offers, coupons, referrals), `ads` (sponsored placements, `ADS_ENABLED`), `security` (`clientIp()`, CSP, field encryption, SSRF-safe fetch, `validateSecrets`).
- Domain modules: `packages/{identity,catalogue,billing,enquiry,search,ai}`.

PostgreSQL 17 + pgvector (embeddings, HNSW) + Postgres FTS; Redis for cache, rate limits, session revocation and the event stream.

This deliberately **supersedes the indicative stack in ADR-006/ADR-009**. Kafka is replaced by a transactional outbox relayed to Redis Streams, and OpenSearch by Postgres FTS plus pgvector hybrid search. This is recorded in `docs/adr/ADR-040-stack-supersedes-006-009.md`.

## Commands

```bash
brew services start postgresql@17 redis   # local services (or: docker compose up -d)
cp .env.example .env.local                 # first time
pnpm install                               # also runs prisma generate
pnpm db:migrate                            # apply migrations (prisma migrate deploy)
pnpm db:seed                               # dummy categories, sellers, products
pnpm dev                                   # buyer web on :3000
pnpm dev:seller | pnpm dev:admin | pnpm dev:studio   # seller :3002, admin :3001, studio :3004
pnpm --filter @cnote/api dev               # public API + MCP on :3003
pnpm --filter @cnote/api openapi           # regenerate docs/api/openapi.json
pnpm worker                                # outbox relay + handlers + jobs + identity mail queue (required)

pnpm db:test:prepare                                 # once, and again after pulling migrations: create/migrate isolated cnote_test + cnote_live_test and set cnote.allow_purge=on there (works without .env.local)
pnpm typecheck | pnpm lint | pnpm test | pnpm build   # all workspaces
pnpm test:coverage                                   # per-package coverage thresholds (vitest.shared.ts)
pnpm test:e2e:build && pnpm test:a11y && pnpm test:e2e   # Playwright UI tests (axe WCAG 2.2 AA + journeys); see docs/guides/testing.md
pnpm --filter @cnote/enquiry test                    # one package
# app package names: @cnote/web, @cnote/seller-app, @cnote/admin-app, @cnote/studio-app, @cnote/api, @cnote/worker
# (@cnote/admin is the RBAC package, not the admin app; a --filter that matches nothing exits 0 silently)
pnpm --filter @cnote/enquiry exec vitest run test/matching.test.ts -t "cascades"   # one test

pnpm db:new <snake_name>   # schema change → new migration (non-interactive; see below)
bash scripts/migrate-lock.sh acquire|release <owner>   # serialise schema edits when several agents share a checkout
pnpm db:check              # CI guard for raw-SQL objects
pnpm check:boundaries   # ADR-006: declared deps, no cycles, model ownership
```

**Migrations.** Edit the module's `packages/db/prisma/schema/<module>.prisma`, then run `pnpm db:new <name>`. Don't use `prisma migrate dev` directly: Prisma can't model the pgvector HNSW indexes or the generated `listings.search_tsv` column and will try to drop them. `db:new` strips those statements, and `db:check` fails CI if one slips through. `db:new` diffs the schema against **your local database**, not against git: a dev DB that carries another branch's migrations or hand edits yields unrelated `DROP`s. Always read the generated `migration.sql` before committing and remove anything your schema change did not cause. Append-only triggers are invisible to the diff, so it never drops them. Read and write `embedding` columns with `$queryRaw` using `toVectorLiteral()` from `@cnote/db`.

CI (`.github/workflows/ci.yml`) runs `db:check`, `db:migrate`, then typecheck, lint, test and build against pgvector and Redis service containers.

## Architecture rules

**Modular monolith (ADR-006).** Each domain module is a workspace package with a single public entry (`src/index.ts`, the module's contract). Boundaries are enforced by package `exports` and declared dependencies. The allowed dependency graph is:

- `identity`, `billing` and `admin` → `core`, `db`
- `catalogue` → + `ai`, `identity`
- `search` → + `ai`, `catalogue`, `identity`
- `enquiry` → + `ai`, `catalogue`, `identity`, `billing`

Don't add cycles. A module queries **only the Prisma models in its own schema file**. It reaches other modules through their public functions or domain events. The one sanctioned exception is `billing.consumeCredit/refundCredit(tx, …)`, which join the caller's transaction. Domain packages are framework-free (no `next/*` imports): `apps/web` reads cookies and calls module functions. Web code is organised as routes in `src/app/…` and feature components in `src/features/<module>/`.

**Event log (ADR-007).** The append-only domain event log (`EnquiryCreated`, `LeadMatched`, `LeadAccepted`, `QuoteSent`, `DealReportedOffPlatform`, …) is the source of truth for analytics and ML features. Emit events with `emit(tx, type, aggregate, payload)` from `@cnote/core`, inside the same `prisma.$transaction` as the state change. Event types and payloads are declared in `packages/core/src/events/catalog.ts` with a version per type; changing a payload shape means bumping the version, never editing the old shape. Handlers (exported on each module's `worker`) must be idempotent, because delivery is at-least-once.

**Data model (ADR-007).**
- `Business` is a single entity; buyer and seller are *roles*, not separate types.
- Model the full Enquiry → Match → Conversation → Quote → Order lifecycle now, even though Phase-1 deals close off-platform, because off-platform closes are *reported* via a "did this close?" prompt.
- Every listing and enquiry carries a language tag, an embedding version and a moderation status.
- The consent ledger is a first-class, purpose-scoped entity, not a metadata column.
- Money uses integer paise (`BigInt` columns; convert with `Number()` at module boundaries and in event payloads), and the Phase-2 ledger is double-entry and immutable.
- The credit ledger and consents are append-only: current state is derived and never updated in place.

**AI-Orchestration (ADR-008).** No product module calls a model vendor directly. All AI goes through typed capabilities (`scoreIntent`, `match`, `extractListing`, `moderate`, `transcribe`, …) behind provider-agnostic interfaces. For every AI decision that affects a user:
- log the prompt version, model ID and redacted inputs;
- route to a human ops queue when confidence is below threshold;
- gate prompt or model changes on golden-set evals.

Keep matching synchronous and under 2s. Cataloguing and extraction run as async jobs. `AI_PROVIDER=heuristic` (the default, used in CI) is an offline, deterministic provider so everything runs without API keys. `anthropic` uses Claude for reasoning capabilities. Embeddings default to a local 256-dim hashing embedder (`EMBEDDING_DIM`); bump `embeddingVersion` and re-index on any change.

**Trust is the product (ADR-000, 002, 003, 005, 009).**
- Leads go to at most N sellers (default 3, configurable per category), and each seller sees the intent score, N and their rank.
- A seller who declines within 2h cascades the slot to the next seller.
- Lead credits auto-refund within 72h if the buyer is unreachable or fake, with no support ticket.
- Ranking = relevance × trust score, **never paid tier alone**. Sponsored slots are always labelled.
- Pricing is public and self-serve: no auto-upgrade, no auto-renew without confirmation, and credits roll over for 90 days.

**Compliance (ADR-010).**
- Store and process all personal data in India regions only.
- Minimise or redact PII before any external model call.
- Voice notes are personal data, so they need consent and a retention policy.
- Run a prohibited-category classifier on every listing, including AI-generated ones (ADR-003/004).
- Hold no card data in Phase 1.

**Accessibility is a release blocker for the buyer web.** `apps/web`, and the `@cnote/ui` components it renders, must meet **WCAG 2.2 AA**:
- keyboard-operable with visible focus and no traps;
- semantic landmarks and heading order;
- a label for every control, with errors announced via `aria-describedby`/`aria-live`;
- colour contrast of at least 4.5:1;
- targets of at least 24px (44px on mobile);
- `prefers-reduced-motion` respected;
- no information conveyed by colour alone.

Prefer `@cnote/ui` primitives, which carry the correct ARIA, over hand-rolled widgets. The `jsx-a11y` lint rules and the axe-core e2e scans (`pnpm test:a11y`, English and Hindi, desktop and Pixel 7) gate CI for `apps/web`; add an axe spec under `e2e/a11y/` for every new buyer screen. The seller and admin apps are not held to this gate.

**Bharat-native UX (ADR-004).** Build for vernacular and Hinglish-first, low bandwidth and mobile first. Seller onboarding is WhatsApp-first; the web is the tertiary path. Search must handle mixed-script and transliterated queries.

**Auth (identity).** Sign-in is by email/password or Google OAuth (PKCE). A short-lived HS256 JWT access token (`cnote_at`, 15 min) is paired with an opaque rotating refresh token (`cnote_rt`, 30 days). Only the refresh token's hash is stored, in `AuthSession`, and reusing an old refresh token revokes the session. Redis caches session revocation and holds the rate limits for sign-in, sign-up, reset and OTP. Refresh happens in `apps/web/src/proxy.ts`, because Server Components can't set cookies. Phone OTP is T0 *verification* (ADR-003), not login. Back-office access is granted only through `StaffMember` rows (see `packages/admin`), never through env vars or plan.

**Client IP:** never parse `X-Forwarded-For` yourself; use `clientIp()` from `@cnote/security` (the first XFF entry is client-controlled; see the security rules for `TRUST_CLOUDFLARE`). **HMAC tokens:** compare the canonical base64url signature string, not decoded bytes.

**Append-only is enforced in Postgres (security audit M5).** `admin_audit_log`, `credit_ledger`, `ad_wallet_ledger`, `consents`, `ledger_journals`, `ledger_lines`, `domain_events` (only `published_at` may change) and `cookie_consent_receipts` (only `person_id` -> NULL) have `BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` triggers. Never "fix" a test or a feature by updating such a row. A retention purge that deletes from them must run inside `withPurge(tx => ...)` from `@cnote/db` (transaction-local `cnote.allow_purge`). Test DBs default the setting on, production does not. See `docs/security/security-architecture.md` section 8 and `docs/ops/db-roles.md`.

**Cookie consent (buyer web, seller app; DPDP s.6).** Every cookie/localStorage/sessionStorage key and third-party script must be in the app's registry (`apps/web/src/features/consent/registry.ts`, `apps/seller/src/features/consent/registry.ts`) with a category (`necessary`, `analytics`, `marketing`, `functional`) and be written only after that category is granted (`clientGranted()` in the browser, `requireConsent()` on the server). **Any registry or notice-string change needs a `CONSENT_POLICY_VERSION` + `CONSENT_POLICY_UPDATED` bump and a new committed `policy-snapshots/v<N>.json`** (never edit an older snapshot); the snapshot test fails otherwise, and a bump re-asks every visitor. Receipts store no IP or user agent. Third-party iframes go inside `<ConsentGate>`; the storefront embed block is dark behind `STOREFRONT_EMBEDS_ENABLED` (turning it on moves web policy v3 to v4 and needs a web rebuild). The seller app has its own cookie, registry and snapshots; admin and studio are necessary-only (`storage-registry.ts` + `auditNecessaryOnlyApp` test, no banner: when that test fails, add a banner or gate the write, never edit the test). See `docs/design/cookie-consent.md`.

**Production startup validation (`validateSecrets`, `packages/security/src/secrets.ts`).** With `NODE_ENV=production` every app and the worker refuse to start on: weak or missing JWT secrets (realm secrets must differ from each other and from `JWT_SECRET`), missing or invalid `FIELD_ENCRYPTION_KEYS` / `BLIND_INDEX_KEY`, missing `DATABASE_URL` / `REDIS_URL`, Postgres without `sslmode=require|verify-ca|verify-full` (waiver `DB_TLS_OPTIONAL=1`), Redis not `rediss://` (waiver `REDIS_TLS_OPTIONAL=1`), `OTP_DEV_ECHO=true`, a missing webhook secret for any ENABLED provider (Razorpay, Cashfree, escrow, credit, KYC, WhatsApp Cloud), `REVALIDATE_SECRET` under 32 characters, missing `DOMAIN_CHECK_SECRET` with custom domains on, `CSP_REPORT_ONLY=1` without `CSP_REPORT_ONLY_ACK=1`, and missing Turnstile keys on web/seller (unless `HUMAN_VERIFIER=off`). The buyer web also refuses to start without the legal-entity env vars unless `LEGAL_ENTITY_STRICT=false`. A new env var that production must have gets a check there and a case in `packages/security/test/human.secrets.test.ts`. Checklist: `docs/ops/production-checklist.md`.

**Security rules (audit H1-H4, M1-M10; controls in `docs/security/security-architecture.md`, decisions in ADR-042).**
- No built-in webhook secrets and no mock partners in production. An unset `ESCROW_WEBHOOK_SECRET` / `CREDIT_WEBHOOK_SECRET` means nothing verifies, so set them in `.env.local` when you use the mock partner (`vitest.setup.ts` sets test values). The mock payment/escrow/credit partner is refused under `NODE_ENV=production` unless the e2e-only `PAYMENTS_ALLOW_MOCK_IN_PRODUCTION` / `ESCROW_MOCK_CHECKOUT` / `CREDIT_MOCK_CHECKOUT` is set. Webhooks accept only the configured partner and read bodies with `readBodyCapped`.
- OTP echo: the code is returned to the caller only when `OTP_DEV_ECHO=true` AND the sender is the console one AND (`NODE_ENV` is not production OR `ALLOW_OTP_ECHO_IN_PRODUCTION=1`, which is for e2e and the dev k8s overlay only) (`packages/identity/src/dev-echo.ts`).
- Client IP: `clientIp()` honours `cf-connecting-ip` only with `TRUST_CLOUDFLARE=1` (set it on every Cloudflare-fronted deploy, with the origin locked to Cloudflare); otherwise it counts `TRUSTED_PROXY_HOPS` entries from the right of `X-Forwarded-For`.
- Prompt injection: pass user text to a model only through `userInputEnvelope()` (`packages/ai/src/envelope.ts`, escapes `<`, `>`, `&`). `ai.moderate()` runs a deterministic prohibited-content pre-check before the model and merges verdicts by strictness: **the model may escalate but can never relax a deterministic block or review**. Listing auto-approval needs deterministic-clean + model allow + tier/trust + account age + staff-approved history, and 5% of auto-approvals (`LISTING_AUTO_APPROVE_SAMPLE_RATE`) also go to the ops queue for audit.
- Fetches of user-supplied hosts go through `assertPublicHttpTarget` + `pinnedFetch` (`@cnote/security`). CSV/xlsx exports use the formula-injection helper. Server actions are capped at 2mb; forms with files post to route handlers that use `readBoundedFormData`.
- DPDP: a module with a retention policy also needs an `exportPersonalData` source in `@cnote/compliance` (a test fails otherwise). UI erasure needs step-up (password, MFA code or a fresh OTP).

**Admin UI.** GET filter forms in `apps/admin` use `FilterBar` / `FilterField` / `FilterInput` / `FilterSelect` / `FilterCheckbox` / `FilterActions` and `SectionNav` from `apps/admin/src/components/filters.tsx` (equal 36px controls, label above the control). `filters.test.tsx` fails on any `<form method="get">` or action-less `<form>` under `src/app` and `src/features`. Every admin mutation still goes through `audited()`.

**AI eval gate (ADR-008).** Changing the text of a system prompt in `packages/ai` needs a version bump, a refreshed `prompts.manifest.json` (`eval:manifest --write`) and a live Anthropic eval baseline (`packages/ai/evals/baseline/anthropic.json`; CI runs the live job in the protected `ai-evals` environment, and without a key a prompt or model change fails the PR unless the baseline is refreshed). Register a new `SYSTEM` prompt in `evals/prompt-manifest.ts`. Plan, ad spend and sponsorship must never affect organic rank or lead matching (property tests also grep the ranking sources). See `docs/guides/ai-evals.md`.

**Feature flags** are env-driven, default off, and documented in `.env.example`: Phase 2/3 (`ESCROW_ENABLED`, `DISPUTES_ENABLED`, `QUOTE_ASSIST_ENABLED`, `QUALITY_CHECKS_ENABLED`, `ONDC_ENABLED`, `CREDIT_ENABLED`, `A2A_ENABLED`, `PRICE_INTEL_ENABLED`), `ADS_ENABLED` (pending legal review, ADR-024) and `STOREFRONT_EMBEDS_ENABLED` (video/map embed until its content is moderated). `PROMOTIONS_ENABLED` and `REACHABILITY_CHECK_ENABLED` default on. A spec that needs a flag sets it in `e2e/support/env.ts` with a comment.

**Tests** never touch dev data: `vitest.setup.ts` points Postgres at `<db>_test` / `<live_db>_test` and Redis at logical DB 1 (override with `TEST_DATABASE_URL`, `TEST_LIVE_DATABASE_URL`, `TEST_REDIS_URL`; CI sets them to its ephemeral services). Use unique ids/emails per test anyway, since packages run in parallel.

**Seed data.** `pnpm db:seed` loads dummy categories, sellers and products for development. Real catalogue data will replace it, so don't build logic that depends on specific seed rows.

## UI reference

**Design research:** consult Mobbin (MCP `search_flows` / `search_screens` / `search_sections`) before designing new screens or flows, and cite what you adopted in the feature's design doc (see DESIGN.md).


See `DESIGN.md` for tokens, components and page anatomy. `docs/design/home-reference.png` is the target look for the buyer-facing homepage:
- **Header:** top nav with Products, Manufacturers, Templates & Design, AI Tools, Business Services and Resources menus, plus a Deliver-to location picker, Request Quote, Orders, Sign in and a purple "Join for Free" CTA.
- **Hero:** a tabbed AI search box (AI Search / Products / Manufacturers / Templates / Business Services) with "Try asking" chips.
- **Category grid:** "Shop by Category".
- **Promo cards:** AI design, Request Quote with verified-supplier badges, and a Connect with Manufacturers card with a map of India.
- **Popular Products:** cards showing ₹ price per unit and minimum order quantity.

The palette is purple primary with an orange accent for quote CTAs. Verified badges must reflect the real verification tier (ADR-003), never payment.

## Non-goals

B2C retail, cross-border export (Phases 1–2), owning inventory or logistics, balance-sheet lending before Phase 3, and building our own LLM.
