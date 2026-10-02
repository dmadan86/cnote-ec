# Security architecture

Defence in depth: **edge → app → data**, with supply-chain and operations layers around them. Cloudflare is the
first edge; every control that lives in code sits behind a port so AWS, Azure or GCP can replace it (see the
portability table). Compliance context: ADR-010 (DPDP, India regions, PII minimisation).

Code map: `packages/security` (CSP, headers, bot check, field encryption, secrets, request helpers),
`packages/next-kit/src/security.ts` (proxy glue), `packages/identity/src/mfa.ts` + `totp.ts` (MFA),
each app's `src/proxy.ts` (composition).

## 1. Layers

### Edge (Cloudflare)
| Control | Setting |
| --- | --- |
| TLS | Full (strict), minimum TLS 1.2, TLS 1.3 on, automatic HTTPS rewrites, origin certificate or Authenticated Origin Pulls |
| HSTS | App sends `max-age=31536000; includeSubDomains` in production. Enable at Cloudflare too once every subdomain is HTTPS-only |
| WAF | Cloudflare Managed Ruleset + OWASP Core Ruleset (paranoia 2, score threshold medium), Managed Free Ruleset |
| Rate limiting | Rules below (checklist). App limits are stricter and give the friendly error; edge limits stop floods before they reach Node |
| Bots | Bot Fight Mode (or Super Bot Fight Mode on paid), Turnstile on sign-up and OTP, block known-bad ASNs on admin |
| DDoS | Automatic L3/4/7 mitigation; keep the origin IP private (firewall to Cloudflare ranges) |
| Caching | Never cache `/account`, `/api`, admin or seller; the app already sends `private, no-store` |
| Admin exposure | Admin host behind Cloudflare Access (SSO) or an IP allow-list; see checklist |

### App
- **Realms** (`packages/identity`): web, seller and admin are separate auth domains: distinct JWT key + audience, `__Host-` cookies, refresh sessions and lifetimes. A token from one realm never verifies in another.
- **RBAC**: back-office privileges are code-defined roles (`packages/admin/rbac.ts`); every admin mutation goes through `audited()`.
- **MFA (TOTP, RFC 6238)**: **required for the admin realm**, optional for sellers. Sign-in never issues a session to the browser until the second factor passes. Details in section 4.
- **CSP** (nonce-based): see section 3.
- **Other response headers** (every app, redirects included): HSTS (prod), `X-Content-Type-Options: nosniff`, `Referrer-Policy` (`no-referrer` on admin), `Permissions-Policy` (camera/mic/geolocation/payment/usb off), `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-site`, `Origin-Agent-Cluster`, legacy `X-Frame-Options`, `X-Robots-Tag: noindex` on admin/seller/studio.
- **CSRF**: `SameSite=Lax` cookies, Next server actions' built-in origin check, and `assertSameOrigin(req)` for hand-written route handlers (Origin/Referer/`Sec-Fetch-Site`).
- **Rate limits**: `RATE_LIMITS` presets + `enforceRateLimit()`; identity applies its own limits (sign-in per IP and email, sign-up, reset, OTP, MFA verification 8 per 5 min per person).
- **Bot protection**: Turnstile on sign-up (web + seller) and OTP requests via `verifyHumanOrThrow(formData)`; fails closed in production if unconfigured.
- **Input validation**: zod at every module boundary; `safeRedirectPath()` / `safeNext()` for post-login redirects.
- **SSRF guard**: `assertPublicHttpUrl(url)` for any user-supplied outbound URL (webhooks, domain checks, image import): https only, no credentials, every resolved address must be public.

### Data
- **Field-level encryption**: `encryptField(plaintext, context)` / `decryptField()`. AES-256-GCM envelope encryption: a fresh data key per value, wrapped by a KMS port. The AAD binds the ciphertext to a context such as `business.pan:<id>`, so a value copied to another row or column fails authentication. Format: `v1.<kid>.<wrappedDEK>.<iv>.<ct>.<tag>` (base64url).
- **Key rotation**: put the new key first in `FIELD_ENCRYPTION_KEYS` (or set `FIELD_ENCRYPTION_ACTIVE_KID`), deploy, run a backfill using `needsReencryption()` / `reencryptField()`, then retire the old id.
- **Blind indexes**: `blindIndex(value, purpose)` (HMAC-SHA256, per-purpose key derived from `BLIND_INDEX_KEY`) gives equality lookup on encrypted columns (PAN, GSTIN, phone) without decrypting rows.
- **What to encrypt**: PAN, GSTIN-adjacent personal identifiers, bank details when added, KYC document references, TOTP secrets (already), webhook secrets. Non-sensitive business names and listing content stay plaintext for search.
- **RLS option**: Postgres row-level security keyed on `app.business_id` for the seller and buyer tables is a later hardening step; not enabled yet.
- **Backups**: encrypted at rest, India region only, restore drill each quarter, retention aligned with the DPDP retention policy; PITR on the primary.
- **DPDP**: consent ledger is append-only; `exportPersonalData` / `erasePerson`; PII is scrubbed from logs and Sentry (`packages/observability`); no card data in Phase 1.

### Supply chain
- Lockfile committed and CI installs with `--frozen-lockfile`.
- `pnpm-workspace.yaml` `onlyBuiltDependencies`: only listed packages may run install scripts.
- Dependabot (`.github/dependabot.yml`): weekly npm, GitHub Actions and compose updates, grouped; security advisories immediately.
- CodeQL (`.github/workflows/codeql.yml`): `security-extended` on push, PR and weekly.
- Enable GitHub secret scanning + push protection and branch protection (required reviews, required CI).
- Pin third-party GitHub Actions by SHA before production hardening.

### Operations
- **Security events**: `logSecurityEvent(type, data)` writes one JSON line (secrets dropped, emails masked) for CSRF blocks, CSP violations, rate-limit hits, MFA failures, bot rejections. Ship these to your log platform and alert on spikes; swap the sink with `setSecurityEventSink()` to persist elsewhere.
- **Audit**: `AdminAuditLog` is append-only for every admin mutation.
- **Sentry**: PII scrubbing in `packages/observability`; the CSP allows only the DSN's ingest host.
- **Secrets**: `assertRequiredSecrets(app)` at start-up fails fast in production (section 5).

## 2. Portability

| Concern | Cloudflare (now) | AWS | Azure | In-code seam |
| --- | --- | --- | --- | --- |
| WAF / managed rules | Cloudflare WAF | AWS WAF managed rule groups | Front Door WAF (DRS + bot rules) | none (edge only) |
| DDoS | Included | Shield Standard / Advanced | Front Door / DDoS Protection | none |
| CDN / TLS | Cloudflare | CloudFront + ACM | Front Door | `Cache-Control` set by the app |
| Rate limiting (edge) | Rate limiting rules | WAF rate-based rules | Front Door rate-limit rules | app-level `RATE_LIMITS` |
| Bot check | Turnstile | WAF Bot Control / CAPTCHA (or hCaptcha) | Front Door bot protection (or hCaptcha) | `HumanVerifier` port: `HUMAN_VERIFIER=turnstile\|hcaptcha\|recaptcha\|off` |
| Admin lockdown | Cloudflare Access | Verified Access / ALB OIDC / WAF IP set | Entra Application Proxy / Front Door access restrictions | `ADMIN_APP_URL` only |
| Key management | (local keyring) | KMS | Key Vault | `KeyManagementService` port: `FIELD_KMS=local\|aws\|azure\|gcp` (stubs documented in `field-crypto.ts`) |
| Secrets | Workers/Pages secrets or Doppler | Secrets Manager | Key Vault | `SecretsProvider` port (`envSecrets` today) |
| Headers / CSP | App (proxy.ts) + optional Transform Rules | App, or CloudFront response headers policy | App, or Front Door rules engine | `staticHeaderList(app)` emits the same headers for any layer |
| Client IP | `CF-Connecting-IP` | `X-Forwarded-For` (ALB) | `X-Azure-ClientIP` / XFF | `requestContext()` reads XFF then `X-Real-IP` |

Nothing in the app assumes Cloudflare except the optional `CF-Connecting-IP` fallback in the CSP report handler.

## 3. Content Security Policy

Built by `buildCsp({ app, nonce, reportUri, allow })`; applied by each app's `proxy.ts` on every response, redirects included.

- `default-src 'self'`; `script-src 'self' 'nonce-…' 'strict-dynamic'` (no `unsafe-inline`; `unsafe-eval` only in dev); `object-src 'none'`; `base-uri 'self'`; `form-action 'self' https://accounts.google.com`; `frame-ancestors 'none'` (`'self'` on web); `upgrade-insecure-requests` in production.
- `style-src 'self' 'unsafe-inline'`: React style props, next/font and Tailwind runtime need inline styles. Script execution is the XSS-critical directive. `CSP_STRICT_STYLES=1` switches to nonce'd `<style>` elements with `'unsafe-inline'` only for style attributes; try it in Report-Only first.
- `img-src` adds the `MEDIA_PUBLIC_BASE_URL` origin; `connect-src` adds the Sentry ingest origin (from the DSN); web adds Clarity only when `NEXT_PUBLIC_CLARITY_PROJECT_ID` is set; Turnstile (`https://challenges.cloudflare.com` for script, frame and connect) on web/seller when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set.
- **Nonce vs static pages.** Next only stamps a nonce while rendering per request. Dynamic pages (everything in admin and seller, plus web's account, sign-in and sign-up pages) get the nonce policy. Statically generated / ISR pages (the public buyer catalogue) cannot, so they get the same policy in *static mode*: `script-src 'self' 'unsafe-inline'`. Public web pages skip the proxy for performance and cache; give them the static header via `next.config.ts` `headers()` using `staticHeaderList({ app: "web" })`. Moving them to hash-based CSP (Next `experimental.sri`) would remove `unsafe-inline` and keep ISR.
- **Rollout.** Set `CSP_REPORT_ONLY=1`: the header becomes `Content-Security-Policy-Report-Only`, Next still applies nonces, and violations land at `POST /api/csp-report` as `csp.violation` security events. Watch for a week, fix, then unset.
- Server Components read the nonce with `getNonce()` (or `(await headers()).get("x-nonce")`) for any hand-written `<script>`.

## 4. MFA

- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) on `node:crypto`; ±1 step window; each step usable once (`lastUsedStep` compare-and-swap); 10 one-time recovery codes stored as sha256 hashes and consumed atomically; secret encrypted with `encryptField` (context `person_mfa.totp:<personId>`); verification rate-limited to 8 per 5 minutes per person.
- **Admin**: password or Google → if MFA enabled, a code is required; if not, forced enrollment. In both cases the session tokens are parked in Redis (5 minutes, encrypted) behind an opaque httpOnly `…_mfa` cookie and only released after the factor passes. The admin proxy also redirects any signed-in person without MFA to `/account/security` (covers sessions minted before rollout).
- **Sellers**: optional at `/settings/security`; once enabled the same sign-in step applies.
- Recovery: another admin cannot reset your MFA silently. A super_admin resets it by deleting the `person_mfa` row (audited via the normal admin tooling / DB change process) and the person re-enrolls at next sign-in.

## 5. Secrets

`assertRequiredSecrets(app)` in production fails start-up on: missing or weak JWT secret (under 32 chars, placeholder text, low entropy); realm secrets equal to each other or to `JWT_SECRET`; missing `FIELD_ENCRYPTION_KEYS` / `BLIND_INDEX_KEY` or wrong lengths; missing `DATABASE_URL` / `REDIS_URL`; missing Turnstile secret or site key on web/seller (unless `HUMAN_VERIFIER=off`). Outside production it only warns.

Environment variables: `TRUST_CLOUDFLARE`, `TRUSTED_PROXY_HOPS`, `GRIEVANCE_VERIFY_SECRET` (optional, defaults to `JWT_SECRET`), `CSP_REPORT_ONLY`, `CSP_STRICT_STYLES`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`, `HUMAN_VERIFIER`, `HCAPTCHA_SECRET`, `RECAPTCHA_SECRET`, `FIELD_ENCRYPTION_KEYS` (`kid1:base64key,kid2:base64key`, 32-byte keys, first is active), `FIELD_ENCRYPTION_ACTIVE_KID`, `FIELD_KMS`, `BLIND_INDEX_KEY` (base64, 32+ bytes), `MFA_ISSUER`, `MFA_ADMIN_OPTIONAL` (dev only, ignored in production), `JWT_SECRET_WEB|SELLER|ADMIN`. Generate keys with `openssl rand -base64 32`.

## 5a. Identity, authentication and verification controls

Hardening from the identity audit. Code lives in `packages/identity` unless noted; each control has a regression test.

- **GSTIN verification proves ownership signals, not just existence** (ADR-003). `verifyGstin` (buyer account, seller verification) now runs the strict `gst/verify.ts` checks: registry status, legal/trade-name similarity against the business's declared name, state match (company address, else the business state), PAN consistency when declared. Pass gives tier 1; borderline (partial name, missing/different state) queues a staff review item and changes no tier; mismatch fails. The registry legal name is only adopted after a match and never over a declared name. **Squatting:** a GSTIN held by an unverified business, or by one whose own names do not match the registry, is released to the verified, name-matching claimant in the claimant's transaction (failed record on the squatter, `GstinClaimReleased` event). A verified, name-matching holder is never displaced automatically: the claimant gets a staff dispute item, and staff resolve it with approve (moves the GSTIN) or reject. Staff can also release any business's claim from the business page ("Dispute this GSTIN", privilege `businesses.verify`, audited). Proof of control (a GSTN OTP to the registered contact) is a provider port, `gst/control.ts`, with a dev mock that refuses to run in production; production needs a GSP/KYC vendor with taxpayer-OTP authentication wired into the forms (see the file header).
- **OTP dev echo**: `OTP_DEV_ECHO` is ignored whenever `NODE_ENV=production` (`dev-echo.ts`), so a mis-set flag can never return a code. E2E plants codes in Redis instead (`e2e/support/otp.ts`).
- **Phone OTP sign-in runs the MFA gate** (`next-kit/src/otp.ts`): after `verifyLoginOtp` the session is parked behind the MFA step (`beginMfaChallenge`) exactly like password and Google sign-in, and the unlock does not complete until it passes. The admin realm refuses OTP sign-in entirely.
- **Account pre-hijack**: linking Google to an account whose email was never verified revokes all of that person's sessions in the same transaction, drops the password and flips the Redis markers after commit.
- **Client IP**: `cf-connecting-ip` is honoured only with `TRUST_CLOUDFLARE=1` (set it on every deploy behind Cloudflare; see `docs/ops/deploy.md`). A short `X-Forwarded-For` chain never falls back to the first, client-controlled entry (it yields the rightmost, proxy-appended one).
- **No account enumeration**: sign-up for an existing email returns a success-shaped response (tokens backed by no session) and emails the owner; password reset enqueues its mail on the `identity.mail` job queue (consumed by the identity worker) so known and unknown addresses take the same time.
- **Brute force** (`auth-guard.ts`): on top of the fixed per-IP/per-email windows, progressive per-account backoff (sign-in: free for 5 failures, then 15s doubling, capped at 15 minutes; MFA: after a full 8-per-5-minutes window). The wait is skipped for an IP the account already has a session from, and a successful sign-in or password reset clears it, so an attacker cannot permanently lock the victim out. Bursts (10 per account / 100 global per 5 minutes) log one `auth.failure_burst` security event; route it with `setSecurityEventSink` to the SIEM/alerting. Passwords are checked against a bundled top-10k breached list (SecLists, no network).
- **Refresh-token race**: the immediately previous refresh token returns the already-rotated pair for 10 seconds (kept AES-GCM encrypted in Redis, keyed from `JWT_SECRET`); with no cached pair it fails without revoking. Reuse after the window still revokes the whole session.
- **Revocation on Redis outage**: a failed "revoked" cache write deletes the cached "valid" marker (readers fall back to the DB) and, if that also fails, logs `SECURITY:` loudly.
- **Reset and confirmation links** carry secrets in the URL, so `/reset-password` and `/grievance/verify` always send `Referrer-Policy: no-referrer` (proxy header, `next.config`, and page metadata).
- **Anonymous DPDP rights requests** (`packages/compliance`): an access/erasure/correction/nomination/withdraw request without a signed-in person is created unverified and a signed, expiring (7 days) HMAC link is emailed to the contact address. Staff see "Requester verified / not verified" and cannot start or resolve it until verified (rejecting is always allowed); the SLA clock starts at verification; unconfirmed requests close themselves after 7 days. Complaints and takedown notices are unaffected.
- **Listing preview tokens** (`packages/catalogue`): the MAC key is HKDF-derived with a purpose label from `PREVIEW_TOKEN_SECRET`/`JWT_SECRET`, not the raw secret (as for storefront previews).

## 6. Threat model (STRIDE summary)

| Threat | Example | Mitigations |
| --- | --- | --- |
| **S**poofing | Credential stuffing on sign-in; stolen admin password | Per-IP and per-email limits, scrypt hashes, Turnstile, edge rate limits, admin MFA, realm-isolated tokens, refresh-token reuse detection |
| **T**ampering | CSRF on state-changing routes; ciphertext swapped between rows; DOM XSS | SameSite + origin checks, AAD-bound field encryption, nonce CSP, output escaping by React, sanitise-html for stored rich text |
| **R**epudiation | Staff denies a change | Append-only `AdminAuditLog`, security event log, immutable consent and credit ledgers |
| **I**nformation disclosure | DB dump; PII in logs or Sentry; leaked referrer URLs | Field encryption + blind indexes, PII scrubbing, `Referrer-Policy`, `no-store` on private pages, India-region storage |
| **D**enial of service | Sign-up or OTP flood, OTP SMS cost abuse | Cloudflare DDoS + rate rules, Turnstile, per-phone and per-IP OTP limits, queue back-pressure |
| **E**levation of privilege | Buyer session used on admin; IDOR on business data; SSRF to metadata service | Realm-bound JWT audience/keys, server-side RBAC in every layout/action, per-module ownership checks, `assertPublicHttpUrl`, admin behind Access |

Residual risks: XSS mitigation on static pages relies on `unsafe-inline` until SRI hashes are adopted; TOTP is phishable (WebAuthn/passkeys are the next step for admin); local keyring keeps KEKs in env (move to a cloud KMS in production).

## 7. Cloudflare configuration checklist

1. DNS: proxy (orange cloud) all app hostnames; API host too; firewall the origin to Cloudflare IP ranges or use Authenticated Origin Pulls.
2. SSL/TLS: Full (strict); Min TLS 1.2; TLS 1.3 on; Always Use HTTPS; HSTS (max-age 6 months to start, includeSubDomains after auditing subdomains).
3. WAF: deploy Cloudflare Managed + OWASP rulesets (log first, then block); enable leaked-credentials detection.
4. Rate limiting rules (edge, per IP):
   - `POST /api/auth/*` and the sign-in/sign-up/forgot-password Server Action paths (`POST /signin`, `/signup`, `/forgot-password`, `/reset-password`): 30 requests / 1 min, then challenge for 10 min.
   - OTP endpoints (`/api/otp/*` or the paths of the OTP server actions): 10 / 10 min per IP, block 1 h.
   - `POST /mfa` (admin and seller): 20 / 5 min per IP.
   - `POST /api/csp-report`: 60 / 1 min.
   - Public API (`api.<domain>/v1/*`): per API key and per IP, according to plan.
5. Bots: Bot Fight Mode on; Turnstile widget created for the web and seller hostnames (site key to `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, secret to `TURNSTILE_SECRET`).
6. Admin host: put `admin.<domain>` behind **Cloudflare Access** (Zero Trust, IdP SSO, require the company domain) or a WAF custom rule `not ip.src in $office_ips and not cf.access...` to block; keep the app's own sign-in + MFA behind it. Same option for `seller` staging hosts.
7. Cache rules: bypass cache for `/account*`, `/api/*`, admin and seller hosts; respect origin headers for the public catalogue.
8. Transform Rules (optional): add `Strict-Transport-Security` at the edge; leave CSP to the app because it carries per-request nonces.
9. Logging: enable Logpush (HTTP requests, firewall events) to India-region storage; alert on WAF block spikes and `csp.violation` volume.
10. Turn CSP enforcement on: run one week with `CSP_REPORT_ONLY=1`, review `/api/csp-report` events, then remove it.
