# ADR-027: Prisma 7 multi-file schema per module with a raw-SQL guard

**Status:** Accepted

**Context.** ADR-006 requires strict module boundaries, and one giant `schema.prisma` erases them. Prisma cannot model pgvector HNSW indexes or the generated `listings.search_tsv` column and, with `migrate dev`, tries to drop them.

**Options.**
1. Single schema file, `prisma migrate dev`. Simple; drops the raw-SQL objects and blurs ownership.
2. Multi-file schema (`prisma/schema/<module>.prisma`) with a wrapper `db:new` that generates migrations non-interactively, strips statements that would drop raw-SQL objects, and a CI guard `db:check`.
3. Another ORM or query builder with first-class extension support. Rewrite cost and less type safety.

**Decision.** Option 2. `packages/db/prisma/schema/` holds `_base.prisma` plus one file per module (identity, catalogue, enquiry, billing, platform, messaging, templates, reviews, wishlist, developer, leadgen, storefront, admin). A module queries only models in its own file. Developers run `pnpm db:new <name>`, never `migrate dev`. `pnpm db:check` fails CI if a migration drops or alters the guarded objects. Embedding columns are read and written with `$queryRaw` using `toVectorLiteral()`. The live read database has its own schema and migrations in `packages/live-db` (ADR-033). Prisma 7 with the `pg` driver adapter; no query-engine binary at runtime.

**Rationale.**
- Ownership is visible in the file tree and reviewable in PRs.
- CI blocks the most damaging class of migration mistake.
- Migrations stay reproducible and non-interactive, which suits agents and CI.

**Consequences.**
- Cross-module joins are deliberately awkward; use public functions or events.
- Raw SQL objects live outside the Prisma model and need hand-written migrations.
- Two migration toolchains (authoring DB and live DB) must both run in the release job (`deploy/docker/migrate.sh`).

**Review.** Revisit if Prisma gains first-class support for pgvector indexes and generated columns, or if the guard produces false positives more than occasionally.
