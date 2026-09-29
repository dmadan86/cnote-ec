# ADR-030: Separately hosted apps (web, seller, admin, studio, api) plus @cnote/next-kit

**Status:** Accepted

**Context.** The buyer site, seller portal, back office, storefront/template studio and public API have different audiences, availability needs and threat models. One deployable would put staff tooling on the public surface and prevent independent scaling and access control.

**Options.**
1. One Next.js app with route groups. Simple; shared blast radius, one cookie scope, admin reachable from the public host.
2. Separate deployable per audience over the same workspace packages.
3. Micro-frontends. Overkill.

**Decision.** Option 2. `apps/web` :3000 (buyer, WCAG 2.2 AA gate), `apps/admin` :3001 (staff), `apps/seller` :3002 (onboarding + portal), `apps/api` :3003 (Hono REST `/v1` + MCP `/mcp`), `apps/studio` :3004 (storefront/template studio), `apps/worker` (no HTTP). Each is its own image and host, so cookies are host-scoped and the edge can apply per-host WAF and Access policy. `@cnote/next-kit` holds the shared Next glue: cookie sessions over identity, `authRoute`, `createAuthProxy`, server-action helpers, security header helpers and OTP client forms; pages stay thin and compose module functions and `@cnote/ui`.

**Rationale.**
- Independent scaling, deploys and blast radius; admin can sit behind Access.
- Uniform auth and error handling through next-kit, so a fix lands once.
- Shared UI tokens through `@cnote/ui` keep the products visually consistent.

**Consequences.**
- More pipelines and images (6 plus a migrate job); mitigated by identical Dockerfiles and one Kustomize base.
- Cross-app navigation needs absolute URLs (`APP_URL`, `SELLER_APP_URL`, `ADMIN_APP_URL`).
- next-kit must not import domain-specific code or it becomes a hidden coupling point.

**Review.** Merge or split apps only on evidence: e.g. fold studio into seller if the audiences and release cadence converge.
