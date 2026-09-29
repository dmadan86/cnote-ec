# Cloudflare setup (edge, storage, WAF, bot protection)

Cloudflare is the first-choice edge and object store (ADR-036), but nothing in the application imports a Cloudflare SDK:
R2 is reached through the S3 API (`MEDIA_DRIVER=r2`), Turnstile is a plain HTTPS verify call, and custom hostnames are
driven through an adapter in `@cnote/domains`. Moving away is a config change; see `docs/architecture/portability.md`.
No secrets belong in this file or the repository. Store tokens in your secret manager and the runtime `cnote-secrets`.

## 1. DNS and zones

| Hostname | Points at | Proxy |
|---|---|---|
| `www.<domain>` (buyer web) | app origin (LB / Tunnel) | proxied |
| `seller.<domain>`, `admin.<domain>`, `studio.<domain>`, `api.<domain>` | app origins, one host per app (auth cookies are host-scoped) | proxied |
| `media.<domain>` | R2 public bucket custom domain | proxied |
| `sites.<domain>` (fallback origin for storefront custom hostnames) | web origin | proxied |

- SSL/TLS mode **Full (strict)**; origin certs from Cloudflare Origin CA or your ingress cert manager. Min TLS 1.2, HTTP/3 on, Always Use HTTPS on.
- Origin exposure: prefer **Cloudflare Tunnel** (`cloudflared`) or restrict the LB security group to Cloudflare IP ranges plus authenticated origin pulls.
- Admin (`admin.<domain>`): put behind **Cloudflare Access** (IdP + device posture) in addition to app MFA. Defence in depth, not a replacement (ADR-029).

## 2. R2 buckets (media)

Two logical buckets (`@cnote/media`):

| Bucket | Purpose | Access |
|---|---|---|
| `cnote-private` | originals, pending or rejected images, template drafts | never public; read through app routes or short-lived presigned URLs |
| `cnote-public` | approved derivatives only (AVIF/WebP variants) | public via custom domain `media.<domain>` only; disable the `r2.dev` URL |

1. Create both buckets in an **India-adjacent jurisdiction** setting where offered; personal data must stay in India (ADR-010). Media are product images, but verification documents are personal data: keep them in the private bucket and confirm the jurisdiction with counsel.
2. Create an **R2 API token** scoped to the two buckets, Object Read and Write. Store the key pair as `MEDIA_ACCESS_KEY_ID` / `MEDIA_SECRET_ACCESS_KEY`.
3. Attach `media.<domain>` to `cnote-public` (R2 > bucket > Settings > Custom Domains). Set `MEDIA_PUBLIC_BASE_URL=https://media.<domain>`.
4. Env: `MEDIA_DRIVER=r2`, `MEDIA_BUCKET=cnote-public`, `MEDIA_PRIVATE_BUCKET=cnote-private`, `MEDIA_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com`, `MEDIA_REGION=auto`.
5. CORS on `cnote-private` only if browsers upload with presigned PUT: allow the seller and studio origins, methods `PUT`, headers `Content-Type`.
6. Cache rule for `media.<domain>/*`: Edge TTL 1 month, Browser TTL 1 month (URLs are content-addressed by image id; a replaced photo gets a new id).
7. Lifecycle: abort incomplete multipart uploads after 1 day; expire rejected-image objects per the retention policy.

## 3. Custom Hostnames (seller storefront domains, ADR-034)

Storefronts can be served on a seller's own domain via **Cloudflare for SaaS (SSL for SaaS)**.

1. Enable Cloudflare for SaaS on the zone. Set the **fallback origin** to `sites.<domain>` and add a proxied DNS record for it.
2. Create an API token limited to `SSL and Certificates: Edit` and `Custom Hostnames: Edit` on that zone. Store as secrets `CF_API_TOKEN` and `CF_ZONE_ID` and set `EDGE_PROVIDER=cloudflare` (adapter: `packages/domains/src/edge/cloudflare.ts`; see portability.md).
3. The app creates a custom hostname per verified domain (`ssl.method=txt`, `type=dv`), shows the seller the CNAME and TXT records, and polls status. Status maps to `StorefrontDomain.status` and emits `StorefrontDomainStatusChanged`.
4. The web app resolves `Host` to a storefront in `proxy.ts`; unknown hosts get a 404, never the buyer site.
5. Limits: plan-dependent count of custom hostnames; certificate renewals are automatic. Monitor the pending-validation queue.

## 4. WAF and rate limiting (starter rules)

Managed rulesets on: Cloudflare Managed, OWASP Core (paranoia low, log first, then block), Free Managed. Custom rules, in order:

| # | Expression (summary) | Action |
|---|---|---|
| 1 | `admin.` host and not from allowed IdP or Access session | Block (Access handles it) |
| 2 | URI path in `/api/auth/*` or `/v1/*` and cf.threat_score > 30 | Managed Challenge |
| 3 | Known bad bots (`cf.bot_management.score < 30`, if Bot Management) or verified-bot allow-list exceptions for Googlebot, Bingbot, and AI crawlers you accept (`/llms.txt`) | Challenge / Allow |
| 4 | Request body over 10 MB outside upload routes | Block |
| 5 | Countries you never serve for admin and api write methods | Block (optional) |

Rate limiting rules (per IP, per 10 s or 1 min; the app also enforces per-identity limits in Redis):

- `POST /api/auth/*` and OTP send routes: 10 per minute, Managed Challenge. The app's own OTP limits per phone/IP/visitor still apply.
- `POST /v1/*` and `/mcp`: 300 per minute per API key header or IP, Block for 1 minute (app limit `API_RATE_LIMIT_PER_MIN`).
- `GET /search`: 60 per minute per IP, Managed Challenge.

Cache rules: bypass cache when the `cnote_at` / `cnote_rt` cookies are present on HTML routes that are private; honour origin `Cache-Control` (`s-maxage`, `stale-while-revalidate`) for public ISR pages. Purge by tag/URL from the worker via the revalidation hook (see `docs/design/performance-and-seo.md`).

## 5. Turnstile

1. Turnstile > Add widget for each public form host (web, seller). Mode **Managed**; hostnames = the app hostnames.
2. Site key goes to the client (`NEXT_PUBLIC_TURNSTILE_SITE_KEY`); secret key to `TURNSTILE_SECRET` (server only) with `HUMAN_VERIFIER=turnstile` (default; `hcaptcha` / `recaptcha` / `off` also supported by `@cnote/security`). Tokens are verified server-side before OTP sends, sign-up and enquiry creation; in production a missing secret fails closed.
3. Use the always-pass test keys in dev and CI; never ship them.

## 6. Other settings

- Bot Fight Mode on (free) or Super Bot Fight Mode (Pro+); JS detections on.
- Security headers (CSP, HSTS, etc.) are set by the apps (ADR-037), not by Transform Rules, so behaviour is identical off-Cloudflare. HSTS preload only after every subdomain is HTTPS.
- Email: Cloudflare Email Routing is fine for inbound support mail; outbound transactional mail uses a provider chosen by `EMAIL_PROVIDER`, with SPF/DKIM/DMARC records on the sending domain.
- Logs: Logpush to your object store if you need edge logs; strip cookies and IPs per DPDP.
- Access-token hygiene: least-privilege API tokens, expiry set, IP-restricted where possible; rotate quarterly.

## 7. Checklist before go-live

- [ ] Both R2 buckets exist; public one only through `media.<domain>`; `r2.dev` disabled
- [ ] Full (strict) TLS; origin locked to Cloudflare (Tunnel or IP allow-list)
- [ ] Access policy on `admin.<domain>`
- [ ] WAF managed rules on; rate limits created; Turnstile widgets live
- [ ] Custom hostnames fallback origin verified with a test domain
- [ ] `docs/architecture/portability.md` runbook rehearsed once (restore R2 to S3, DNS TTL lowered)
