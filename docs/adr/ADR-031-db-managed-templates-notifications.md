# ADR-031: DB-managed email and notification templates with queue delivery

**Status:** Accepted

**Context.** Marketing and trust copy changes weekly and must be editable by non-engineers with review; hard-coded strings in sending paths make every wording change a deploy and block localisation. Delivery must survive provider outages and honour consent (ADR-010).

**Options.**
1. Copy in code with i18n files. Deploy per change; no maker-checker.
2. Third-party template/CRM tool. PII leaves our boundary; no knowledge of trust rules.
3. Templates in the database, edited in an admin studio, rendered server-side; delivery through the job queue.

**Decision.** Option 3. `@cnote/templates` stores `MessageTemplate`, `MessageLayout` (header/footer) and versions (draft, published, rollback), with rich text, assets and sanitised, Mustache-style variables. Code only registers keys, variables and defaults (`defineTemplates`), seeded on worker start. `@cnote/notifications` observes domain events and enqueues jobs, applying `NotificationPreference` and marketing consent; `@cnote/email` renders and sends through `EmailProvider` (`EMAIL_PROVIDER=console|smtp|ses|resend`), records `EmailMessage` status and retries transient failures, marking permanent failures without retry. Marketing category is consent-gated. Maker-checker (`promotions.manage` vs `publish`) is the pattern for public-facing copy (ADR-025).

**Rationale.**
- Copy changes ship in minutes with versions and rollback, without deploys.
- Delivery is decoupled from request latency and retried safely.
- One place enforces preferences and consent.

**Consequences.**
- Templates in the DB need seed and migration discipline across environments.
- Sanitisation and variable validation are a security surface (XSS/injection); covered by `templates/sanitize.ts` tests.
- Production email providers are still stubs (ADR-coverage).

**Review.** Review when localisation begins: add per-locale variants and translation workflow.
