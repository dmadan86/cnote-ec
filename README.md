# cnote: AI-first B2B marketplace for Indian MSMEs

A trust-first lead marketplace positioned against broadcast-lead incumbents. Buyers post requirements; an AI intent score and a capped, exclusive matching engine send each lead to at most three verified sellers; leads that turn out fake or unreachable are refunded automatically. Sellers get vernacular-friendly onboarding, storefronts and transparent pricing. The working name is TBD.

- **Phase 1** (current): trust-first lead marketplace, one vertical (still to be chosen). Phase 2 and 3 modules (escrow, disputes, negotiation, quality checks, ONDC, credit, agent-to-agent, price intelligence) are built and tested but **flagged off** by default; see [ADR coverage](docs/adr/ADR-coverage.md) and the flags in `.env.example`.
- Source of truth for decisions: [ADRs](docs/adr/ADR-v0.1.md). How much of them is built: [ADR coverage](docs/adr/ADR-coverage.md).

## Architecture

```
                         Cloudflare (CDN, WAF, Turnstile, R2, custom hostnames)
                                          |
     +----------+------------+------------+------------+-------------+
     | web      | seller     | admin      | studio     | api         |
     | :3000    | :3002      | :3001      | :3004      | :3003       |
     | buyer    | onboarding | staff back | storefront | REST /v1    |
     | Next 16  | + portal   | office     | + template | MCP /mcp    |
     |          | Next 16    | Next 16    | studio     | Hono        |
     +----+-----+-----+------+-----+------+-----+------+------+------+
          |           |            |            |             |
          +-----------+------+-----+------------+-------------+
                             |   workspace packages (modules, TypeScript source)
        identity  catalogue  search  enquiry  billing  ai  reviews  wishlist  alerts  leadgen
        templates email notifications developer storefront domains security media  consent
        admin  observability  ui  next-kit  core  db  live-db
                             |
        +--------------------+----------------------+---------------------+
        | Postgres 17        | Redis               | Object storage      |
        | + pgvector + FTS   | cache, limits,      | R2 / S3 (private +  |
        | authoring DB       | streams, job queue  | public buckets)     |
        | + LIVE read DB     |                     |                     |
        +---------^----------+----------^----------+---------------------+
                  |                     |
              +---+---------------------+---+
              | worker: outbox relay -> event transport (Redis Streams),
              | module observers, queue consumers, scheduled jobs
              +-----------------------------+
```

Key ideas: a modular monolith of workspace packages (each with one public entry), a transactional outbox for domain events, provider ports selected by env (storage, edge, search, queue, email, KMS), and separately hosted apps with per-app auth realms. See ADR-026 to ADR-044.

## Apps and ports

| App | Package | Port | Purpose |
|---|---|---|---|
| `apps/web` | `@cnote/web` | 3000 | Buyer marketplace (WCAG 2.2 AA gate) |
| `apps/admin` | `@cnote/admin-app` | 3001 | Staff back office (RBAC, moderation, templates) |
| `apps/seller` | `@cnote/seller-app` | 3002 | Seller onboarding and portal |
| `apps/api` | `@cnote/api` | 3003 | Public REST API + MCP server |
| `apps/studio` | `@cnote/studio-app` | 3004 | Storefront and template studio |
| `apps/worker` | `@cnote/worker` | none | Outbox relay, event handlers, queue consumers, cron |

## Quick start

Requirements: Node 22+, pnpm 10 (`corepack enable`), Postgres 17 with pgvector, Redis.

Option A, Homebrew services:

```bash
brew services start postgresql@17 redis
cp .env.example .env.local
pnpm install            # also runs prisma generate
pnpm db:migrate
pnpm db:seed            # dummy categories, sellers, products
pnpm dev                # buyer web on :3000
pnpm worker             # in another terminal: REQUIRED (see below)
```

**The worker is required.** It runs the outbox relay, event handlers, queues and schedulers, and it sends account emails: password reset, "someone tried to register with your email" and DPDP request confirmations are enqueued on the `identity.mail` queue and are only delivered while a worker is running. Without it those flows look like they hang.

Option B, Docker (infra only; apps on the host):

```bash
docker compose up -d                               # postgres (pgvector) + redis
docker compose --profile storage up -d minio minio-init   # optional S3-compatible storage
docker compose --profile search up -d opensearch          # optional search backend
cp .env.example .env.local && pnpm install && pnpm db:migrate && pnpm db:seed && pnpm dev
```

Option C, everything in containers:

```bash
docker compose up -d postgres redis && pnpm db:migrate     # Next builds read the DB
docker compose -f docker-compose.yml -f docker-compose.apps.yml up --build
```

Other apps: `pnpm dev:seller`, `pnpm dev:admin`, `pnpm dev:studio`, `pnpm --filter @cnote/api dev`. Grant staff access with `pnpm admin:grant <email> <role...>`.

### Local environment notes (`.env.local`)

- **Redis password.** Docker compose starts Redis with `requirepass` (`REDIS_PASSWORD`, default `cnote-dev-redis`, dev only), so with Option B or C set `REDIS_URL=redis://:cnote-dev-redis@localhost:6379`. With Homebrew Redis (Option A, no password) keep `REDIS_URL=redis://localhost:6379`. Compose binds Postgres, Redis, OpenSearch and MinIO to `127.0.0.1`.
- **Webhook secrets for mock partners.** There are no built-in webhook secrets. If you turn on `ESCROW_ENABLED` or `CREDIT_ENABLED` with the mock partner, set `ESCROW_WEBHOOK_SECRET` / `CREDIT_WEBHOOK_SECRET` to any dev value, otherwise the mock webhooks cannot be signed or verified. (Tests set their own in `vitest.setup.ts`.)
- **`DOMAIN_CHECK_SECRET`** is required only when the custom-domain probe is on (`DOMAINS_HTTP_PROBE=true` or a real `EDGE_PROVIDER`); generate one with `openssl rand -base64 32`.
- **`MFA_ADMIN_OPTIONAL=1`** (dev only, ignored in production) lets an admin sign in without enrolling MFA; otherwise the first admin sign-in forces enrolment. `OTP_DEV_ECHO=true` (already in `.env.example`) returns phone OTP codes in the response and fails startup validation in production.
- Field-encryption keys and `BLIND_INDEX_KEY` are optional in dev (a deterministic dev key is used); production requires them. Production requirements are in [docs/ops/production-checklist.md](docs/ops/production-checklist.md).

### Tests and test databases

```bash
pnpm db:test:prepare    # once, and again after pulling new migrations: creates/migrates cnote_test + cnote_live_test (works without .env.local)
pnpm test               # unit + integration; never touches dev data
pnpm test:e2e:build && pnpm test:a11y && pnpm test:e2e   # Playwright; see docs/guides/testing.md
```

### Demo logins (after `pnpm db:seed`)

| Role | Email | Password |
|---|---|---|
| Seller (Demo Packaging Works, tier 2) | `seller-demo@example.com` | `DemoSeller#2026` |
| Buyer (Demo Buyer Enterprises) | `buyer-demo@example.com` | `DemoBuyer#2026` |

Dev data only (`apps/worker/src/seed.ts`). Staff access has no seeded login: sign up on the public site (the person must exist first), then run `pnpm admin:grant <email> super_admin`.

### Where things run

| URL | What |
|---|---|
| http://localhost:3000 | Buyer marketplace (`/hi/...` Hindi) |
| http://localhost:3002 | Seller onboarding and portal |
| http://localhost:3001 | Admin back office (staff only, MFA) |
| http://localhost:3004 | Storefront and template studio |
| http://localhost:3003 | Public REST API (`/v1`, OpenAPI at `/openapi.json`, live docs at `/docs`) |
| http://localhost:3003/mcp | MCP server (Streamable HTTP, same bearer API key as REST; see [docs/api/README.md](docs/api/README.md)) |

Create an API key in the buyer web at `/account/developers`, then for example `claude mcp add --transport http cnote http://localhost:3003/mcp --header "Authorization: Bearer ck_live_..."`.

## Commands

| Command | What it does |
|---|---|
| `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build` | Across all workspaces |
| `pnpm test:coverage` | Vitest with coverage |
| `pnpm --filter @cnote/enquiry test` | One package |
| `pnpm db:new <name>` | New migration (never use `prisma migrate dev`). It diffs against your local DB, so read the generated SQL and drop unrelated `DROP`s |
| `pnpm db:test:prepare` | Create/migrate the isolated test databases |
| `pnpm db:check` | CI guard for raw-SQL objects |
| `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:reset` | Apply, seed, reset the authoring DB |
| `pnpm --filter @cnote/live-db migrate:deploy` | Migrate the LIVE read DB |
| `pnpm --filter @cnote/api openapi` | Regenerate `docs/api/openapi.json` |

## Configuration

Copy `.env.example` to `.env.local`. Essentials: `DATABASE_URL`, `LIVE_DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` (32+ random bytes), `APP_URL` / `ADMIN_APP_URL` / `SELLER_APP_URL` / `API_PUBLIC_URL`. Provider selectors (all default to local or offline): `AI_PROVIDER`, `MEDIA_DRIVER`, `EMAIL_PROVIDER`, `QUEUE_DRIVER`, `SEARCH_BACKEND`, `EDGE_PROVIDER`, `FIELD_KMS`, `HUMAN_VERIFIER`. Feature flags (all off unless noted): `ESCROW_ENABLED`, `DISPUTES_ENABLED`, `QUOTE_ASSIST_ENABLED`, `QUALITY_CHECKS_ENABLED`, `ONDC_ENABLED`, `CREDIT_ENABLED`, `A2A_ENABLED`, `PRICE_INTEL_ENABLED`, `ADS_ENABLED`, `STOREFRONT_EMBEDS_ENABLED` (`PROMOTIONS_ENABLED` and `REACHABILITY_CHECK_ENABLED` default on). Observability is a no-op without `SENTRY_DSN`. The full adapter matrix with env vars is in [portability](docs/architecture/portability.md). Never commit secrets.

## Deploy

- Images: `apps/*/Dockerfile` and `deploy/docker/migrate.Dockerfile`; build with the repo root as context, for example `docker build -f apps/web/Dockerfile .`
- Kubernetes: `kubectl apply -k deploy/k8s/overlays/dev` (Kustomize base, HPA, PDB, migrate Job). Create the `cnote-secrets` Secret out of band.
- Cloudflare setup (R2, hostnames, WAF, Turnstile): [deploy/cloudflare/README.md](deploy/cloudflare/README.md)
- Moving clouds: [docs/architecture/portability.md](docs/architecture/portability.md)
- **Production checklist** (secrets, TLS, Cloudflare, `TRUST_CLOUDFLARE`, worker, `ai-evals` environment): [docs/ops/production-checklist.md](docs/ops/production-checklist.md). With `NODE_ENV=production` the apps refuse to start on missing or weak configuration.
- CI: `.github/workflows/ci.yml` (db guard, migrations, typecheck, lint, test, coverage, build, Docker builds on PRs, e2e); `.github/workflows/ai-evals.yml` (prompt manifest and golden-set evals).

## Documentation

- [CLAUDE.md](CLAUDE.md): working rules for contributors and AI agents (read first)
- [DESIGN.md](DESIGN.md): tokens, components, page anatomy
- ADRs: [ADR-v0.1](docs/adr/ADR-v0.1.md) (000 to 023), [proposed 024/025](docs/adr/ADR-024-025-proposed.md), [ADR-026 to 044](docs/adr/) (build decisions, including [cookie consent](docs/adr/ADR-041-cookie-consent-architecture.md), [security hardening](docs/adr/ADR-042-security-hardening-audit.md) and the [AI eval gate](docs/adr/ADR-043-ai-eval-gate-shadow-mode.md)), [coverage report](docs/adr/ADR-coverage.md)
- Design docs: [GST verification](docs/design/gst-verification.md), [search index](docs/design/search-index.md), [lead generation](docs/design/lead-generation.md), [performance and SEO](docs/design/performance-and-seo.md), [promotions and sponsored](docs/design/promotions-and-sponsored.md), [promotions schema](docs/design/promotions-schema.prisma.md)
- API: [docs/api/README.md](docs/api/README.md), `docs/api/openapi.json`, live docs at `/docs` on the API host
- Guides: [testing](docs/guides/testing.md), [i18n](docs/guides/i18n.md), [AI evals](docs/guides/ai-evals.md), [bulk import](docs/guides/bulk-import.md)
- Security and ops: [security architecture](docs/security/security-architecture.md), [production checklist](docs/ops/production-checklist.md), [deploy](docs/ops/deploy.md), [DB roles](docs/ops/db-roles.md)
- Research: [seller onboarding](docs/research/seller-onboarding.md)
