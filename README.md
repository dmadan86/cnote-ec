# cnote: AI-first B2B marketplace for Indian MSMEs

A trust-first lead marketplace positioned against broadcast-lead incumbents. Buyers post requirements; an AI intent score and a capped, exclusive matching engine send each lead to at most three verified sellers; leads that turn out fake or unreachable are refunded automatically. Sellers get vernacular-friendly onboarding, storefronts and transparent pricing. The working name is TBD.

- **Phase 1** (current): trust-first lead marketplace, one vertical (still to be chosen). Escrow, disputes, quote agents and ONDC are later phases and not built.
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
        identity  catalogue  search  enquiry  billing  ai  reviews  wishlist  leadgen
        templates email notifications developer storefront domains security media
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

Key ideas: a modular monolith of workspace packages (each with one public entry), a transactional outbox for domain events, provider ports selected by env (storage, edge, search, queue, email, KMS), and separately hosted apps with per-app auth realms. See ADR-026 to ADR-039.

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
pnpm worker             # in another terminal: async flows need it
```

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

## Commands

| Command | What it does |
|---|---|
| `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build` | Across all workspaces |
| `pnpm test:coverage` | Vitest with coverage |
| `pnpm --filter @cnote/enquiry test` | One package |
| `pnpm db:new <name>` | New migration (never use `prisma migrate dev`) |
| `pnpm db:check` | CI guard for raw-SQL objects |
| `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:reset` | Apply, seed, reset the authoring DB |
| `pnpm --filter @cnote/live-db migrate:deploy` | Migrate the LIVE read DB |
| `pnpm --filter @cnote/api openapi` | Regenerate `docs/api/openapi.json` |

## Configuration

Copy `.env.example` to `.env.local`. Essentials: `DATABASE_URL`, `LIVE_DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` (32+ random bytes), `APP_URL` / `ADMIN_APP_URL` / `SELLER_APP_URL` / `API_PUBLIC_URL`. Provider selectors (all default to local or offline): `AI_PROVIDER`, `MEDIA_DRIVER`, `EMAIL_PROVIDER`, `QUEUE_DRIVER`, `SEARCH_BACKEND`, `EDGE_PROVIDER`, `FIELD_KMS`, `HUMAN_VERIFIER`. Observability is a no-op without `SENTRY_DSN`. The full adapter matrix with env vars is in [portability](docs/architecture/portability.md). Never commit secrets.

## Deploy

- Images: `apps/*/Dockerfile` and `deploy/docker/migrate.Dockerfile`; build with the repo root as context, for example `docker build -f apps/web/Dockerfile .`
- Kubernetes: `kubectl apply -k deploy/k8s/overlays/dev` (Kustomize base, HPA, PDB, migrate Job). Create the `cnote-secrets` Secret out of band.
- Cloudflare setup (R2, hostnames, WAF, Turnstile): [deploy/cloudflare/README.md](deploy/cloudflare/README.md)
- Moving clouds: [docs/architecture/portability.md](docs/architecture/portability.md)
- CI: `.github/workflows/ci.yml` (db guard, migrations, typecheck, lint, test, coverage, build, Docker builds on PRs).

## Documentation

- [CLAUDE.md](CLAUDE.md): working rules for contributors and AI agents (read first)
- [DESIGN.md](DESIGN.md): tokens, components, page anatomy
- ADRs: [ADR-v0.1](docs/adr/ADR-v0.1.md) (000 to 023), [proposed 024/025](docs/adr/ADR-024-025-proposed.md), [ADR-026 to 039](docs/adr/) (build decisions), [coverage report](docs/adr/ADR-coverage.md)
- Design docs: [GST verification](docs/design/gst-verification.md), [search index](docs/design/search-index.md), [lead generation](docs/design/lead-generation.md), [performance and SEO](docs/design/performance-and-seo.md), [promotions and sponsored](docs/design/promotions-and-sponsored.md), [promotions schema](docs/design/promotions-schema.prisma.md)
- API: [docs/api/README.md](docs/api/README.md), `docs/api/openapi.json`, live docs at `/docs` on the API host
- Research: [seller onboarding](docs/research/seller-onboarding.md)
