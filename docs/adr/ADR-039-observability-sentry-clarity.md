# ADR-039: Observability: scrubbed Sentry and consented Clarity

**Status:** Accepted

**Context.** We need error and performance visibility across six runtimes, but telemetry is a common DPDP leak path (request bodies, emails, phone numbers in breadcrumbs) and behavioural analytics require consent.

**Options.**
1. No third-party telemetry. Blind operations.
2. Sentry with defaults and full session capture.
3. Sentry with an SDK-free options factory that scrubs PII before send, plus Clarity only after analytics consent, only on the buyer web.

**Decision.** Option 3. `@cnote/observability` exports `sentryOptions(app, runtime)`; every app and the worker call `Sentry.init(...)`, a no-op without `SENTRY_DSN`. `beforeSend`/`beforeBreadcrumb` drop cookies, auth headers, request bodies, query strings with tokens, and mask emails, phones and GSTINs; user context is an opaque id only; release and environment tags come from env; source maps upload only in CI/deploy (`SENTRY_AUTH_TOKEN`). Microsoft Clarity loads from the buyer web only after the `analytics` consent is granted (`NEXT_PUBLIC_CLARITY_PROJECT_ID`), never on seller, admin, studio or storefronts. Metrics and traces via OTLP are a follow-up (portability.md).

**Rationale.**
- Actionable errors without personal data in a third-party system.
- Consent respected by construction; the loader is a single gate.
- Self-hostable (Sentry protocol) if residency demands it.

**Consequences.**
- Scrubbing rules need tests as payload shapes evolve.
- Sentry SaaS region and DPA must be confirmed for DPDP.
- No product-metrics pipeline yet (ADR-coverage: metrics layer).

**Review.** Review scrubbing against a sample of real events monthly for the first quarter; decide SaaS vs self-hosted at launch.
