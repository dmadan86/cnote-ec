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
- **Nonce vs static pages.** Next only stamps a nonce while rendering per request. Dynamic pages (everything in admin and seller, plus web's account, sign-in and sign-up pages) get the nonce policy. Statically generated / ISR pages (the public buyer catalogue) cannot, so they get the same policy in *static mode*: `script-src 'self' 'unsafe-inline'`. Public web pages skip the proxy for performance and cache; give them the static header via `next.config.ts` `headers()` using `staticHeaderList({ app: "web" })`. Hash mode exists but needs a per-route edge layer: see "Static pages and CSP" below.
- **Rollout.** Set `CSP_REPORT_ONLY=1`: the header becomes `Content-Security-Policy-Report-Only`, Next still applies nonces, and violations land at `POST /api/csp-report` as `csp.violation` security events. Watch for a week, fix, then unset.
- Server Components read the nonce with `getNonce()` (or `(await headers()).get("x-nonce")`) for any hand-written `<script>`.

### Static pages and CSP (re-evaluated for Next 16)

Goal: drop `script-src 'unsafe-inline'` on the statically generated / ISR pages of the buyer web without making them dynamic.

What was built:

1. **Subresource Integrity on every external script** (`experimental.sri`, `apps/web/next.config.ts`, sha256, opt-out `NEXT_SRI=off`). Next stamps `integrity="sha256-..."` on each `<script src>` it emits, computed at build time, so a tampered chunk (CDN or proxy compromise) is refused by the browser even on pages that cannot carry a nonce. Experimental in Next 16; the e2e suite is the check that hydration still works.
2. **Hash mode in `buildCsp`** (`scriptHashes`): when a page's complete inline-script set is known, script-src becomes `'self' 'sha256-...'` with **no `'unsafe-inline'`**. Hashes are validated (a malformed or keyword-like value throws; no directive smuggling). Combined with a nonce they are simply added.
3. **`pnpm csp:hashes`** (`scripts/csp-hashes.ts`, helper `@cnote/security/csp-hashes`): after `next build`, hashes every executable inline `<script>` in `apps/web/.next/server/app/**/*.html` (data blocks such as `ld+json` are skipped: CSP does not apply to them) and writes `apps/web/.next/csp-hashes.json` with the per-route hashes, the set shared by at least 90% of pages and statistics. This is the artifact for an edge layer (Cloudflare Transform Rules / a Worker, or a CDN headers file) that sets `Content-Security-Policy` per route in hash mode.

What could not be done, precisely:

- The inline scripts of an App Router page are the RSC flight chunks (`self.__next_f.push([...])`) plus the bootstrap. The flight payload is page content, so its hash is **different for every page and changes on every ISR revalidation**. `next.config.ts` `headers()` is evaluated once at build start (before any HTML exists) and is one list for all routes, and the public pages skip the proxy for cacheability. A single global policy can therefore not contain the right hashes, and a policy with *some* hashes makes browsers ignore `'unsafe-inline'`, which blocks the missing flight chunks and the page never hydrates. SRI does not cover inline scripts. The Next 16 guide's sample (`script-src 'self'` with SRI only) holds for pages without inline scripts, which no App Router page is.
- So **the default policy for static and ISR pages still contains `'unsafe-inline'` in `script-src`.** This is the residual risk: an XSS bug on a static page is not blocked by CSP. Mitigations in place: React escaping, `sanitize-html` for stored rich text, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'self'`, `form-action 'self'`, the same `connect-src`/`img-src` allow-lists as nonce pages, SRI on all external scripts, and nonce mode (no `unsafe-inline`) on every dynamic page and on admin, seller and studio.
- The hash policy is only correct when applied per URL by something that sees the final HTML. For fully static routes (no ISR) that is a post-build step; for ISR routes it needs a Worker that hashes the cached response (cacheable per URL) or those routes becoming fully static. Neither is wired in this repo because the hosting layer is undecided; `csp-hashes.json` plus `securityHeaders({ app: "web", scriptHashes })` is everything such a layer needs. Roll it out with `CSP_REPORT_ONLY=1` first.
- Making the affected pages dynamic (nonce) is the other route and costs the CDN/ISR cache; not taken.

Tests: `packages/security/test/csp.test.ts` (hash mode: replaces `unsafe-inline`, empty list stays static, malformed hashes rejected, nonce + hash, `staticHeaderList`), `packages/security/test/csp-hashes.test.ts` (extraction, data blocks, manifest/shared stats), plus the existing static/nonce/report-only tests unchanged.

## 4. MFA

- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) on `node:crypto`; ±1 step window; each step usable once (`lastUsedStep` compare-and-swap); 10 one-time recovery codes stored as sha256 hashes and consumed atomically; secret encrypted with `encryptField` (context `person_mfa.totp:<personId>`); verification rate-limited to 8 per 5 minutes per person.
- **Admin**: password or Google → if MFA enabled, a code is required; if not, forced enrollment. In both cases the session tokens are parked in Redis (5 minutes, encrypted) behind an opaque httpOnly `…_mfa` cookie and only released after the factor passes. The admin proxy also redirects any signed-in person without MFA to `/account/security` (covers sessions minted before rollout).
- **Sellers**: optional at `/settings/security`; once enabled the same sign-in step applies.
- Recovery: another admin cannot reset your MFA silently. A super_admin resets it by deleting the `person_mfa` row (audited via the normal admin tooling / DB change process) and the person re-enrolls at next sign-in.

## 5. Secrets

`assertRequiredSecrets(app)` in production fails start-up on: missing or weak JWT secret (under 32 chars, placeholder text, low entropy); realm secrets equal to each other or to `JWT_SECRET`; missing `FIELD_ENCRYPTION_KEYS` / `BLIND_INDEX_KEY` or wrong lengths; missing `DATABASE_URL` / `REDIS_URL`; missing Turnstile secret or site key on web/seller (unless `HUMAN_VERIFIER=off`). Outside production it only warns.

Also fails start-up in production (security audit M8):

| Check | Fix / documented opt-out |
| --- | --- |
| `OTP_DEV_ECHO=true` (returns one-time codes in API responses) | Remove it. e2e servers and the dev k8s overlay set `ALLOW_OTP_ECHO_IN_PRODUCTION=1` (downgrades to a warning; never on a real deployment). |
| A webhook secret missing for an ENABLED provider: `RAZORPAY_WEBHOOK_SECRET` (`PAYMENTS_PROVIDER=razorpay`), `CASHFREE_WEBHOOK_SECRET` (`=cashfree`), `ESCROW_WEBHOOK_SECRET` (`ESCROW_ENABLED`), `CREDIT_WEBHOOK_SECRET` (`CREDIT_ENABLED`), `KYC_WEBHOOK_SECRET` (`KYC_PROVIDER` not `mock`), `WHATSAPP_APP_SECRET` + `WHATSAPP_VERIFY_TOKEN` (WhatsApp Cloud enabled) | Set the secret, or disable the provider. |
| `REVALIDATE_SECRET` set but under 32 characters | `openssl rand -base64 32`. |
| `DOMAIN_CHECK_SECRET` missing while custom domains are enabled (`EDGE_PROVIDER=cloudflare\|vercel\|aws` or `DOMAINS_HTTP_PROBE=true`) | Set it (no `JWT_SECRET` fallback in production). |
| `CSP_REPORT_ONLY=1` without `CSP_REPORT_ONLY_ACK=1` | Finish the rollout, or acknowledge explicitly (then it is a warning). |
| `DATABASE_URL` / `LIVE_DATABASE_URL` without `sslmode=require\|verify-full\|verify-ca` (hosts `localhost`, `127.0.0.1`, `::1` are exempt) | Add TLS, or `DB_TLS_OPTIONAL=1` for a documented private network. |
| `REDIS_URL` not `rediss://` (localhost exempt) | Use TLS, or `REDIS_TLS_OPTIONAL=1` for a documented private network. |

`@cnote/db` and `@cnote/live-db` no longer fall back to a localhost URL in production: a missing `DATABASE_URL` / `LIVE_DATABASE_URL` throws at first use (`next build` only collects page data and is exempt via `NEXT_PHASE`).


Environment variables: `TRUST_CLOUDFLARE`, `TRUSTED_PROXY_HOPS`, `GRIEVANCE_VERIFY_SECRET` (optional, defaults to `JWT_SECRET`), `CSP_REPORT_ONLY`, `CSP_STRICT_STYLES`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`, `HUMAN_VERIFIER`, `HCAPTCHA_SECRET`, `RECAPTCHA_SECRET`, `FIELD_ENCRYPTION_KEYS` (`kid1:base64key,kid2:base64key`, 32-byte keys, first is active), `FIELD_ENCRYPTION_ACTIVE_KID`, `FIELD_KMS`, `BLIND_INDEX_KEY` (base64, 32+ bytes), `MFA_ISSUER`, `MFA_ADMIN_OPTIONAL` (dev only, ignored in production), `JWT_SECRET_WEB|SELLER|ADMIN`. Generate keys with `openssl rand -base64 32`.

## 5a. Identity, authentication and verification controls

Hardening from the identity audit. Code lives in `packages/identity` unless noted; each control has a regression test.

- **GSTIN verification proves ownership signals, not just existence** (ADR-003). `verifyGstin` (buyer account, seller verification) now runs the strict `gst/verify.ts` checks: registry status, legal/trade-name similarity against the business's declared name, state match (company address, else the business state), PAN consistency when declared. Pass gives tier 1; borderline (partial name, missing/different state) queues a staff review item and changes no tier; mismatch fails. The registry legal name is only adopted after a match and never over a declared name. **Squatting:** a GSTIN held by an unverified business, or by one whose own names do not match the registry, is released to the verified, name-matching claimant in the claimant's transaction (failed record on the squatter, `GstinClaimReleased` event). A verified, name-matching holder is never displaced automatically: the claimant gets a staff dispute item, and staff resolve it with approve (moves the GSTIN) or reject. Staff can also release any business's claim from the business page ("Dispute this GSTIN", privilege `businesses.verify`, audited). Proof of control (a GSTN OTP to the registered contact) is a provider port, `gst/control.ts`, with a dev mock that refuses to run in production; production needs a GSP/KYC vendor with taxpayer-OTP authentication wired into the forms (see the file header).
- **OTP dev echo** (`dev-echo.ts`, one rule for phone verification and phone sign-in): the code is returned to the caller only if `OTP_DEV_ECHO=true` AND no real SMS/WhatsApp provider is configured (`OTP_SENDER` is `console`/unset and the registered sender is not a provider adapter) AND either `NODE_ENV` is not production or `ALLOW_OTP_ECHO_IN_PRODUCTION=1` (e2e and the dev k8s overlay only). A real sender plus the echo flag never returns the code, in any environment.
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

Residual risks: XSS mitigation on static pages relies on `unsafe-inline` (per-page inline-script hashes change with every page and ISR revalidation; SRI and an edge hash policy narrow this, see "Static pages and CSP"); TOTP is phishable (WebAuthn/passkeys are the next step for admin); local keyring keeps KEKs in env (move to a cloud KMS in production).

## 6a. AI moderation, file handling, content and outbound requests

| Control | Where | What it does |
| --- | --- | --- |
| Prompt envelope escaping | `packages/ai/src/envelope.ts` | Every `<user_input>` envelope (all providers) escapes `<`, `>`, `&` in the JSON as `<`, `>`, `&`, so user text such as `</user_input>` cannot close the envelope. |
| Deterministic prohibited-content pre-check | `ai.moderate()` + `heuristic/moderate.ts` | Runs before the model for listings, enquiries, Q&A and storefronts: keyword/regex over normalised text (zero-width stripped, homoglyph fold, leetspeak, spaced letters, Hinglish and Devanagari). The model verdict is merged by strictness: it may escalate, but a deterministic block or review is never relaxed to allow (`deterministic: clean/review/block` is on the result). The golden set carries injection canaries (envelope break, "ignore previous instructions", fake verdict JSON). |
| Auto-approval gates | `catalogue/versions.ts` (`mayAutoApprove`) | Auto-approve needs deterministic-clean AND model allow AND tier/trust AND account age (`LISTING_AUTO_APPROVE_MIN_ACCOUNT_AGE_DAYS`, 30) AND staff-approved history (`LISTING_AUTO_APPROVE_MIN_HUMAN_APPROVED`, 3). A random sample (`LISTING_AUTO_APPROVE_SAMPLE_RATE`, 0.05) of auto-approvals also lands in the ops review queue for post-publication audit. |
| Zip/xlsx bomb guard | `bulk/src/zipguard.ts` | Archives are inflated with a streaming byte budget (16 KB input slices) and judged on the bytes actually inflated, never header-declared sizes: xlsx 200 MB / 1000 parts, ZIP 500 MB / 2000 files, 5 MB per image, 200 columns, declared sheet dimension checked before ExcelJS loads. Lazy per-batch extraction uses the same budget. |
| Formula injection | `security/spreadsheet.ts` | CSV and xlsx exports prefix a quote on text cells starting with `=`, `+`, `-`, `@`, tab or CR (shared by the admin consent export); re-import strips it. Numbers are untouched. |
| Report URL / subjects | `apps/web/.../legal/report.ts` | Control characters (CR, LF, tab, NUL) are rejected in the reported and proof URLs (the WHATWG parser silently strips them), the normalised `href` is stored, and ticket subjects/names are single-line. `fileGrievance` also collapses CR/LF in subjects. |
| PII redaction | `ai/src/redact.ts`, `observability` | Input capped at 20k chars before any regex, bounded quantifiers, irregular `+91` formats and STD landlines, PIN-code addresses, names after "my name is / Mr / Shri / Smt / contact", with property tests. The Sentry scrubber gets the same loose-phone handling and length cap. |
| SSRF and DNS pinning | `security/request.ts`, `security/pinned-fetch.ts` | `assertPublicHttpTarget` resolves DNS once, refuses private/link-local/loopback/metadata ranges (IPv4 and IPv6, mapped, NAT64, 6to4), and returns the validated address; `pinnedFetch` connects to exactly that IP (undici Agent with a pinned lookup), keeps SNI/Host, never follows redirects and caps the body. Used by the custom-domain probe and ONDC outbound callbacks. |
| Domain squatting | `domains/lifecycle.ts` | Hostname is no longer globally unique: unverified claims coexist, expire after `DOMAINS_PENDING_CLAIM_DAYS` (7), and the first claimant to prove DNS control (advisory-locked) pre-empts the rest, with `DomainClaimSuperseded` and a seller notification. Refusals use generic text. |
| Domain check secret | `domains/config.ts` | Per-host probe token is derived with HKDF-SHA256 from a dedicated `DOMAIN_CHECK_SECRET`; no hardcoded fallback and no `JWT_SECRET` reuse (missing secret throws). |
| Report brigading | `reviews/react.ts`, `report-policy.ts` | Auto-hide needs distinct credible reporters (verified email or phone, account at least `REVIEWS_REPORTER_MIN_AGE_DAYS`, 7); otherwise the item stays visible and goes to the ops queue. Reports are rate limited per person (5/h, 15/day) and per IP (30/h). |
| Single live region | `apps/*/features/disputes/forms.tsx` | `Alert` is the live region; content is no longer wrapped in a second `role="alert"`/`status` (a test guards the pattern across the apps). |

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

## 8. Append-only tables (DB-level, security audit M5)

"Append-only" used to be a convention in application code. Migration `20261003000000_append_only_triggers` enforces it in Postgres with `BEFORE UPDATE OR DELETE` row triggers and `BEFORE TRUNCATE` statement triggers (raw SQL that Prisma cannot model, like the pgvector indexes: `prisma migrate diff` ignores triggers, so `pnpm db:new` neither drops nor needs to strip them; `packages/db/test/append-only.db.test.ts` asserts they exist):

| Table | UPDATE | DELETE / TRUNCATE |
| --- | --- | --- |
| `admin_audit_log`, `credit_ledger`, `ad_wallet_ledger`, `consents`, `ledger_journals`, `ledger_lines` | never | only inside a retention purge |
| `domain_events` (outbox) | only `published_at` (the relay) | only inside a retention purge |
| `cookie_consent_receipts` | only `person_id` -> `NULL` (DPDP erasure) | only inside a retention purge |

A purge opts in per transaction: `withPurge(tx => ...)` from `@cnote/db` runs `set_config('cnote.allow_purge', 'on', true)` (transaction-local, so it cannot leak to other queries on a pooled connection). The only production purge on these tables is `purgeCookieConsentReceipts` (compliance retention policy `compliance.cookie_consent_receipts`). The dev seed reset also uses it. Test and e2e databases set `cnote.allow_purge = 'on'` as a database default (`scripts/allow-test-purge.sh`, called by `pnpm db:test:prepare`, e2e `prepare-db.ts` and CI) so suite cleanup can delete; UPDATE is never bypassed, so application code that mutates an append-only row still fails the suite. `packages/db/test/append-only.db.test.ts` runs its denial tests on a client whose sessions start with the setting off, i.e. what production sees.

The setting is a guard against mistakes and ad-hoc SQL by the application role, not against someone who can run arbitrary SQL as that role (they can `SET` it). For that, run production with a separate least-privilege role: see `docs/ops/db-roles.md`.

## 9. DPDP export and erasure (security audit M10)

- **Export** (`GET /account/export`): `@cnote/compliance` keeps an export registry (`EXPORT_SOURCES`, `packages/compliance/src/export.ts`) that mirrors the retention registry. Each module exposes `exportPersonalData(personId, ctx)` from its public API (identity, alerts, enquiry, reviews, wishlist, notifications, catalogue voice-note metadata, leadgen, disputes) and compliance adds cookie-consent receipts; compliance calls the registered functions and never reads another module's tables. A new module that stores personal data adds an exporter here (a test fails if a module with a retention policy has no export source, other than the documented system-only ones).
- **Bounded and streamed**: every collection is capped at `EXPORT_ROW_CAP` (5000, flagged `truncated`), the whole document has a byte budget (`EXPORT_MAX_BYTES`, default 25 MiB; sections beyond it are listed in `_omitted`), sections are produced one at a time and streamed as one JSON document, and a failing module is reported in `_errors` without failing the export. Money (BigInt paise) is serialised as exact strings. The route is rate-limited to 3 per hour per person.
- **Erasure step-up**: `deleteAccountAction` calls `erasePersonWithStepUp`, which requires proof within the last 5 minutes: the account password, an authenticator/recovery code (mandatory when MFA is enabled; the password alone is then refused), or a phone OTP verified in the last 5 minutes. Attempts are limited to 5 per 10 minutes per person. `erasePerson` itself remains for staff-driven and system erasure.

## 10. Upload body limits (security audit)

Server actions share one body limit per app and every page route accepts an action POST, so a limit sized for evidence uploads is a pre-auth memory knob for the whole site. `serverActions.bodySizeLimit` is now `2mb` in web and seller (was 56 MB and 20 MB). File-bearing forms post to dedicated route handlers with their own caps: web `POST /api/rfq` (requirement drawings) and `POST /api/disputes` (evidence), seller `POST /api/disputes` and `POST /api/quotes` (quote attachments), next to the existing seller upload routes (KYC documents, listing images, bulk import). They authenticate before reading the body and use `readBoundedFormData` (`@cnote/next-kit`), which checks the origin, requires a Content-Length within the route's cap and enforces the cap on the bytes actually received. The forms keep their `useActionState` shape: text-only submissions use the server action, submissions with files go to the route (`submitFormAsAction`, with one session refresh + retry on 401). The two web routes are excluded from the proxy matcher so Next does not buffer or truncate their bodies. A server action that receives a file is refused. Admin and studio keep the framework default (1 MB; the KYC audit report upload is sized to fit).

## 11. CI/CD, containers and dependencies (security audit)

- **GitHub Actions** are pinned to full commit SHAs with a `# vX.Y.Z` comment; `.github/dependabot.yml` updates `github-actions` (one grouped PR), `npm`, `docker-compose` and `docker` (base-image tag and digest together). Workflows run with `contents: read`; `ai-evals.yml` passes `github.base_ref` / event data through `env:` rather than interpolating them into scripts.
- **Live AI evals** use the `ANTHROPIC_API_KEY` only through the protected `ai-evals` environment (job-level `environment: ai-evals`). Required setup, which cannot be done from a file: create the environment in Settings > Environments, add required reviewers, optionally restrict deployment branches, and store the key as an *environment* secret (remove any repository-level copy). Fork PRs never receive secrets (`pull_request`, not `pull_request_target`) and fall into the "no key" branch.
- **Containers**: Postgres, Redis, OpenSearch and MinIO ports in `docker-compose*.yml` bind to `127.0.0.1`; Redis requires a password (`REDIS_PASSWORD`, default `cnote-dev-redis`, local dev only; `.env.example` shows both URL forms so brew-services users keep working). Base images are pinned by digest (`node:22-bookworm-slim@sha256:...`, pgvector, redis, opensearch). MinIO stopped publishing community images to Docker Hub/Quay, so its digest could not be resolved: `minio/minio` and `minio/mc` use release tags with a `TODO(supply-chain)` to mirror and pin; resolve with `docker buildx imagetools inspect <image:tag>`.
- **Build secrets**: the Next app Dockerfiles no longer take `DATABASE_URL` / `LIVE_DATABASE_URL` / `REDIS_URL` as build args (args are stored in the image history). Non-secret local-dev placeholders are `ENV` defaults; a real URL goes in through `--secret id=build_env,src=build.env` (compose: `build.secrets`, CI: `secret-files`), mounted for the build step only.
- **Dependencies**: `pnpm.overrides` pin `deepmerge-ts` to `^8.0.2` and `mysql2` to `^3.24.5` (Prisma tooling), clearing the two `pnpm audit --prod` highs and the mysql2 moderate. The lockfile was patched surgically (a plain re-resolve drifts TypeScript to 7.0.2 and breaks eslint). Remaining: moderate `uuid <11.1.1` via `exceljs` (bulk import; `exceljs` uses only `v4`, which the advisory (v3/v5/v6 with a caller-supplied buffer) does not touch).
- **Readiness probes**: the AI and search services' `/ready` return only a status to anonymous callers; configuration problems, provider names and backends need a valid service token.

## 12. Webhooks, money and business-logic abuse

Controls added after the security audit (findings H1, M2, M3, M7 and the payments / notification items).

- **Partner webhooks (escrow, credit).** `handleEscrowWebhook` / `handleCreditWebhook` refuse while `ESCROW_ENABLED` / `CREDIT_ENABLED` is off and accept only the *configured* partner (`ESCROW_PARTNER` / `CREDIT_PARTNER`; a signed `mock` event is a 404 while a real partner is configured). `mock` is refused when `NODE_ENV=production` unless `ESCROW_MOCK_CHECKOUT=1` / `CREDIT_MOCK_CHECKOUT=1`. There is no built-in default secret: an unset `ESCROW_WEBHOOK_SECRET` / `CREDIT_WEBHOOK_SECRET` means nothing verifies (fail closed; tests set them in `vitest.setup.ts`). Escrow apply paths require `escrow.partner === provider` (also for payouts); credit lookups are keyed by `(partner, ref)`. `simulateMockDisbursal(actor, applicationId)` checks the application belongs to the actor's business. With the feature flag off both ingresses still accept, from the configured partner only, the events that settle existing obligations (escrow: funding of existing escrows, payout/refund settled or failed; credit: repayment, close, cancel, overdue, write-off, rejection, disbursal of an already-accepted application) so money in flight is never stranded; credit events that would start something new (new offers, a disbursal that was never accepted) are refused with 503 and redelivered later.
- **Payments.** A `paid` outcome needs a verifiable amount (`fulfilOrder` refuses `undefined`; a webhook without an amount is logged as `amount_unknown` and fulfils nothing; the status-sync path can still reconcile). A webhook can only settle an order whose `provider` equals the webhook's provider. `mockAllowed()` fails closed: only `NODE_ENV` of `development` or `test`, or the guarded `PAYMENTS_ALLOW_MOCK_IN_PRODUCTION=1` (ignored next to a real gateway). The mock webhook returns 400 when not allowed.
- **Webhook body cap.** Every webhook route in `apps/api` (payments, escrow, credit, KYC, WhatsApp, ONDC) reads the body through `readBodyCapped`: a stream that aborts at the cap even without `Content-Length`.
- **Coupons (M3).** Checkout reserves the coupon (`reserveCoupon`, status `reserved` tied to the payment order) before the customer is sent to the gateway. A retry by the same business replaces its own earlier unpaid reservation (the old one is voided, `CouponVoided` reason `superseded_by_new_checkout`), so only one reservation per business is live and parallel checkouts still allow exactly one redemption. Reservations count against `maxRedemptions`, per-business and per-GSTIN limits for `PROMOTIONS_COUPON_RESERVATION_MINUTES` (30) and are released on failed order or by the `promotions.release-coupon-reservations` job. `fulfilOrder` redeems inside its own transaction (`redeemCouponTx`, under a savepoint). If redemption fails the bonus credits are stripped (credits are granted only from a successful redemption), a `CouponRedemptionDiscrepancy` event is emitted and the order's `failureReason` is set to `coupon_discrepancy: ...` for staff.
- **Lead-credit refund farming (M2).** ADR-002's instant 72h refund stays for genuine reports. `buyer_unreachable` refunds (which keep their reachability flow) count toward the same rate and weekly numbers. When a seller's 30-day refund rate exceeds `LEAD_REFUND_GUARD_RATE_BPS` (2000 = 20%, minimum `LEAD_REFUND_GUARD_MIN_ACCEPTED` = 5 accepted leads) or they already have `LEAD_REFUND_GUARD_MAX_PER_WEEK` (5) refunds in 7 days, further `buyer_fake` reports create a `LeadRefundReview` (event `LeadRefundHeld`) instead of refunding; staff decide in the admin console (`/lead-refunds`). A refunded lead is closed for the seller (conversation unreadable, buyer details and phone hidden). Seller refund claims feed the trust score through `LeadRefunded` (`refundsClaimed`, only the share above 20% of accepted leads costs points), and a refund drops the verified-enquiry badge from the buyer's reviews of that seller (unless another accepted lead remains).
- **Deal reports (M7).** Only the buyer's own `won` report creates the Order. A seller's `won` is advisory: stored, emits `DealClaimedBySeller` (the buyer is notified and sees a confirm prompt) and creates nothing; it is hidden from the buyer's "latest answer" and quote-comparison decision.
- **`pickSellers`.** The seller cap is recounted inside the locked transaction.
- **Enquiry posting limits.** 10/h per business, 15/h per person and 30/h per client IP (`clientIp()`); the IP key is passed by the web actions and the public API.
- **Notification flooding.** `message.received` emails are coalesced to one per recipient per conversation per 15 minutes (`NOTIFY_MESSAGE_EMAIL_WINDOW_SECONDS`); later messages fold into one `message.digest` email sent when the window ends, and each recipient is capped at `NOTIFY_MESSAGE_EMAIL_DAILY_CAP` (20) message emails per UTC day. In-app notifications are unaffected. Sender-controlled names are sanitised (CR/LF and control characters stripped, 60 characters) and the mailer strips CR/LF from every subject.
