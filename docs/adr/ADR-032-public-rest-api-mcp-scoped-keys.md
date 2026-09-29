# ADR-032: Public REST API and MCP with scoped personal API keys

**Status:** Accepted
**Note:** Accelerates ADR-020 (external agent API); does not implement agent-to-agent negotiation.

**Context.** ADR-020 wants an authenticated, rate-limited external API so third-party procurement agents can transact, the opposite of Amazon's block-agents stance. Sellers and buyers also want integrations and Apidog-style testing.

**Options.**
1. Wait for Phase 3.
2. Ship a public API later behind partner contracts.
3. Ship now: REST `/v1` with OpenAPI 3.1 and an MCP server, authenticated by personal API keys.

**Decision.** Option 3. `apps/api` (Hono, `@hono/zod-openapi`) serves `/v1/*`, `/openapi.json`, `/docs`, `/health` and `/mcp`. Keys are managed in `@cnote/developer`: created by a user, scoped per feature (e.g. catalogue read, enquiry create), expiry 1d, 7d, 30d, 90d, 1y or never, shown once, only the sha256 stored; per-key usage counters (`ApiKeyUsageDaily`); rate limits per minute (`API_RATE_LIMIT_PER_MIN`, MCP separate); CORS allow-list. The same scope check protects REST and MCP. The API calls module functions and enforces the same trust and moderation rules as the web; nothing is reachable that the key holder could not do in the UI.

**Rationale.**
- Agent integrations and partner pilots start early, on a documented contract (`docs/api`).
- Keys are revocable and least-privilege; staff can list and revoke.
- OpenAPI file in the repo is the source for client generation.

**Consequences.**
- A public surface needs abuse controls and versioning discipline (`/v1` stability).
- Scope creep: every new module function exposed needs a scope and tests.
- Lead-contact data must never leak through the API (privacy tests required).

**Review.** Review scopes and quotas quarterly; introduce OAuth for third-party apps if multi-tenant integrations appear.
