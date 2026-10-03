# ADR-037: Security layers: CSP, headers, Turnstile, field encryption and MFA

**Status:** Accepted
**Note:** Designed with parallel work (`@cnote/security`). Hardening after the security audit (fail-closed webhooks, database append-only triggers, production startup validation, deterministic moderation) is in ADR-042.

**Context.** The platform holds business identity documents, phone numbers and GSTINs (personal data under DPDP) and exposes public forms and an API. A single control is never enough; a leak is an existential and regulatory event (IndiaMART 2020).

**Options.**
1. Rely on the edge WAF only.
2. Framework defaults only.
3. Layered controls in code, independent of the vendor edge.

**Decision.** Option 3, layers: (1) Headers from the apps: nonce-based CSP with report endpoint (`CSP_REPORT_ONLY` first, then enforce), HSTS, `X-Content-Type-Options`, Referrer-Policy, frame-ancestors, safe redirect helpers, `poweredByHeader` off. (2) Human verification on OTP send, sign-up and enquiry: `verifyHuman` with Turnstile default, hCaptcha or reCAPTCHA selectable, fail-closed in production. (3) Rate limits in Redis per identity and IP (auth, OTP, API). (4) Field-level envelope encryption for sensitive columns (DEK per record wrapped by a KEK in a KMS adapter, `FIELD_KMS`, keyring with active kid) and a keyed blind index for lookup on encrypted fields (`BLIND_INDEX_KEY`). (5) MFA (TOTP) mandatory for staff; per-realm JWT secrets (ADR-029). (6) Secret validation at boot (production refuses to start with missing or weak secrets). (7) Structured security events to a sink; Sentry scrubbing (ADR-039). (8) Supply chain: CodeQL, Dependabot, lockfile installs.

**Rationale.**
- Defence in depth: the edge can fail or be replaced without exposing the app.
- A database dump does not expose encrypted fields without KMS access.
- Key rotation is possible without re-encrypting data (re-wrap DEKs).

**Consequences.**
- CSP nonces make pages dynamic; conflicts with fully static ISR must be resolved per page (ADR-038).
- Blind indexes support equality only; searching encrypted fields is limited.
- KMS wrappers for AWS/Azure/GCP are stubs; production starts with the local keyring backed by managed secrets.

**Review.** Security review and threat model before public launch; pen test within 90 days of launch; rotate keys on schedule.
