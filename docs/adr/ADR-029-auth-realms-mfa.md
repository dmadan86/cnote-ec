# ADR-029: Auth: email/password, Google and phone-OTP login; JWT access with rotating refresh; per-app realms; staff-only admin with MFA

**Status:** Accepted
**Note:** Refines: ADR-003 (phone OTP is T0 verification). CLAUDE.md originally said phone OTP is verification, not login; phone-OTP login was added for buyers (ADR-035).

**Context.** Buyers, sellers and staff have different risk profiles and live on different hosts (ADR-030). Indian buyers expect phone-based sign-in; sellers may be low-literacy; staff need strong controls. Cookies are host-scoped per app.

**Options.**
1. Third-party identity provider (Auth0, Clerk, Cognito). Fast; per-MAU cost, data-residency questions, lock-in.
2. Own auth in `@cnote/identity`: email/password (argon2-class hashing), Google OAuth (PKCE), phone-OTP login, short JWT plus opaque refresh, realms per app.
3. Single shared session across apps. One cookie domain, larger blast radius.

**Decision.** Option 2. Access token: HS256 JWT `cnote_at`, 15 min. Refresh token: opaque `cnote_rt`, 30 days, only its hash is stored in `AuthSession`; rotated on use and reuse of an old token revokes the session. Redis caches revocation and holds rate limits (sign-in, sign-up, reset, OTP). Each app is a realm (`CNOTE_AUTH_REALM` baked at build: web, seller, admin, studio) with its own cookie name space and its own JWT secret (`JWT_SECRET_WEB|SELLER|ADMIN`), so a token from one realm is rejected by another. Refresh happens in each app's `proxy.ts`. Admin is staff-only: access exists only through `StaffMember` rows granted by `pnpm admin:grant`, never by env or plan, with TOTP MFA (`PersonMfa`) required, RBAC roles to privileges in `packages/admin/rbac.ts`, and every mutation audited to `AdminAuditLog`.

**Rationale.**
- Compromise of one app's session does not authenticate to another.
- Session theft is contained by short access tokens and refresh-reuse detection.
- Staff access is explicit, reviewable and auditable.

**Consequences.**
- We own credential handling: password policy, breach checks, reset flows, OTP abuse limits, and their security review.
- Realm secrets multiply key management (ADR-037 covers rotation).
- SMS/WhatsApp OTP delivery providers are still to be integrated (ADR-coverage gap 1).

**Review.** Review after the first security assessment, or if MAU or compliance needs make a managed IdP cheaper than maintaining ours. Consider WebAuthn/passkeys for staff.
