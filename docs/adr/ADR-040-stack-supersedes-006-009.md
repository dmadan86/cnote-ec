# ADR-040: Implemented stack supersedes the indicative stack in ADR-006 and ADR-009

**Status:** Accepted (records decisions already implemented; ADR-026, 028, 029, 033, 036 hold the detail per area)

**Context.** ADR-v0.1 lists an *indicative* stack ("finalise in DDR"): Kotlin/Spring or Go core, Python ML services, Kafka as the event backbone (ADR-006), OpenSearch as the search engine (ADR-009), Kubernetes on an India-region cloud. The team is small, Phase 1 volumes are low, and the highest risk is trust and product fit, not throughput. The build therefore chose a smaller operational footprint that keeps the *contracts* the ADRs care about: append-only event log as the source of truth (ADR-007), modular boundaries (ADR-006), hybrid lexical and vector search with trust-weighted ranking (ADR-009), India-only data (ADR-010).

**Options.**
1. Follow the indicative stack: polyglot services, Kafka, OpenSearch from day one.
2. TypeScript modular monolith on Postgres and Redis, with ports so Kafka and OpenSearch can be adopted later without touching product code.

**Decision.** Option 2. Specifically:
- **Event backbone:** transactional outbox (`domain_events`, written in the same transaction as the state change via `emit(tx, ...)`), relayed to **Redis Streams**; work queues with retries, backoff and dead letters on Redis Streams. `getEventTransport()` and `getJobQueue()` are ports (`QUEUE_DRIVER=redis|memory|kafka`); the Kafka driver is a stub. Delivery is at-least-once and every handler is idempotent (ADR-028).
- **Search:** Postgres full-text search plus pgvector (HNSW) hybrid retrieval fused in application code, ranked by relevance x trust score, never paid tier alone. `SEARCH_BACKEND=postgres|opensearch` selects an **OpenSearch adapter** (`OpenSearchIndex`, indexer worker, reindex CLI) that is implemented and kept converged but is not the default.
- **Runtime and frameworks:** TypeScript on Node 22, pnpm monorepo, Next.js 16 (App Router) for web, seller and admin apps, Hono for the public REST API and MCP server, Prisma 7 with a multi-file schema (one file per module) and pgvector/FTS objects guarded by `db:check` (ADR-026, 027, 032).
- **CQRS read side:** a separate **live read database** holds the public listing projection (`@cnote/live-db`), rebuildable from authoring data; public reads never touch the authoring DB (ADR-033).
- **Auth:** per-realm JWT (web, seller, admin, studio each with their own secret and cookie namespace) plus rotating opaque refresh tokens; staff-only admin with MFA (ADR-029).
- **Data residency:** all stores, backups, replicas and telemetry in India regions (Mumbai primary, Hyderabad standby); a residency guard refuses non-India hosts (ADR-010, 023, 036).
- **AI:** provider-agnostic capabilities behind ports; `ai-service` and `search-service` are extractable services with in-process fallback (ADR-008, 023).

**Rationale.**
- One deployable language, one database engine and one broker to operate, secure, back up and fail over; fewer moving parts during the phase where the product is still being found.
- The outbox gives the durability and replay properties the ADRs need from Kafka (event log as truth; consumers resume from checkpoints) without a broker cluster.
- Postgres FTS + pgvector meets the ADR-009 quality bar at the current corpus size, and the search port keeps the OpenSearch path open.
- Ports and module boundaries (checked by `pnpm check:boundaries`) make each swap a driver change rather than a rewrite.

**Consequences.**
- Redis Streams has weaker retention, partitioning and multi-consumer replay than Kafka; the Postgres outbox remains the durable source, so a Redis loss is recoverable by re-relaying unpublished or replayed rows (see DR runbook), but long-horizon replay to new consumers reads Postgres.
- Postgres FTS has no built-in Indic analyzers or learned synonyms; transliteration and synonym handling live in application code and must be maintained by us.
- The event log table grows without partitioning; metrics queries scan by `(type, occurred_at)`.
- Python ML workloads (if any) run behind `ai-service`; the polyglot option is deferred, not excluded.
- ADR-006 and ADR-009 text stays as the record of intent; where it names Kafka or OpenSearch as the implementation, this ADR overrides it.

**Revisit triggers.** Re-open this decision when any of the following holds for two consecutive weeks:

| Area | Move toward | Trigger (starting points; calibrate with load tests) |
|---|---|---|
| Events | Kafka (or managed equivalent) | Sustained > 2,000 events/s peak or > 100 M events/day; outbox relay lag p95 > 30 s or backlog > 100 k rows despite scaling workers; need for > 3 independent replaying consumers or cross-region active-active consumption; Redis Streams memory > 50% of node at target retention |
| Event log storage | Partitioning first, then a warehouse/CDC sink | `domain_events` > 500 M rows or metrics nightly job > 30 min |
| Search | OpenSearch as default (`SEARCH_BACKEND=opensearch`) | Live listings > 1 M, or search p95 > 300 ms after index and cache tuning, or facet/aggregation latency > 1 s, or measured Hinglish/vernacular relevance below target on the golden set with Postgres analyzers |
| Vector | Dedicated vector store | > 5 M embeddings, or HNSW build/recall trade-offs block re-indexing windows |
| Read side | More read replicas / regional live DBs | Live DB CPU > 60% at p95, or public-read p95 > 150 ms uncached |
| Services | Split modules out of the monolith | A module needs independent scaling or a separate on-call, or deploy coupling blocks releases > 1 per week |

**Review.** Quarterly, and at every phase gate. When a trigger fires, write the migration ADR first (dual-write or shadow indexing period, rollback plan).
