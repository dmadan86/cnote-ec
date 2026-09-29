# ADR-026: Stack: Next.js 16, Postgres/pgvector and Redis in a pnpm monorepo

**Status:** Accepted
**Note:** Supersedes: ADR-006 indicative stack (Kotlin/Spring or Go, Kafka, Kubernetes-only) and ADR-009 OpenSearch for Phase 1. ADR-006's modular-monolith decision itself stands.

**Context.** ADR-006 left the stack indicative (Kotlin/Spring or Go core, Python ML, Kafka, OpenSearch) and ADR-009 named OpenSearch for search. The team is one founder plus AI agents; the drivers are velocity, one language end to end, and a bill a pre-revenue company can carry (ADR-000 driver 7).

**Options.**
1. Polyglot per ADR-006: JVM/Go core, Python ML, Kafka, OpenSearch. Most operational surface.
2. TypeScript monolith in a pnpm monorepo: Next.js 16 App Router for UIs, Hono for the API, workspace packages as modules; Postgres 17 + pgvector + FTS; Redis for cache, rate limits, streams.
3. Serverless-first on a single vendor. Fast start, hard lock-in, awkward for long-running workers.

**Decision.** Option 2. Each domain module is a workspace package with one public entry (`src/index.ts`) and its own Prisma schema file. Internal packages ship TypeScript source with no build step (apps use `transpilePackages`; api and worker run on tsx). Postgres holds relational data, pgvector holds embeddings (HNSW), Postgres FTS handles lexical search; Redis holds cache, rate limits, session revocation, event streams and the job queue. OpenSearch remains available behind a port (ADR-036, `SEARCH_BACKEND=opensearch`) but is off in Phase 1. Kafka is replaced by a transactional outbox (ADR-028).

**Rationale.**
- One language and one type system across UI, API, worker and modules; agents and humans share conventions.
- Two datastores to run instead of five; hybrid search needs no extra cluster until scale demands.
- The module boundary (ADR-006) is preserved and enforced by package `exports`, so extraction to services stays possible.

**Consequences.**
- Node runtime for ML-adjacent work is weaker: AI capabilities go through vendor APIs behind `@cnote/ai` (ADR-008); a Python service is still the extraction path.
- No compile step means images carry source and a tsx runtime; a bundling step is a follow-up.
- Postgres FTS lacks OpenSearch's analyzers for vernacular scripts; revisit at the OpenSearch trigger below.

**Review.** Revisit OpenSearch when search p95 exceeds 300 ms at production data volume, when non-Latin vernacular analysis is needed, or when catalogue exceeds about 5M documents. Revisit the runtime when a module needs independent scaling (ADR-018).
