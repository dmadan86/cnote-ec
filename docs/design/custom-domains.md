# Custom domains and storefront analytics

Sellers connect their own domain to their storefront. Verification runs on the job queue (like Vercel / Shopify); once DNS is correct and TLS is issued, every request for that host is served by `apps/web` with the seller's storefront. Every storefront request is metered, with privacy-friendly analytics. Code: `packages/domains`, `apps/web/src/features/domains`, seller UI under `/storefront/domains` and `/storefront/analytics`, admin `/domains`.

## 1. Flow

```
seller adds host ──► StorefrontDomain(pending_dns) + token ──► job "domain.verify"
                                                                  │
   ┌──────────────────────────── backoff 15s…1h, up to 72h ◄──────┤ DNS not ready
   ▼                                                               ▼ DNS ready (TXT + CNAME/A)
 misconfigured (after 72h; seller "Check again" restarts)      verifying → verified
                                                                  │  edge.createCustomHostname()
                                                                  ▼
                                                            provisioning_tls ── edge pending: retry (15s…5m), 24h cap
                                                                  │  edge active + HTTPS probe passes
                                                                  ▼
                                                                active ◄── daily re-check ──► misconfigured (DNS broke, edge failed)
```

- **States** (`DomainStatus`): `pending_dns → verifying → verified → provisioning_tls → active | misconfigured`. One check step can walk several states; a `StorefrontDomainStatusChanged` event is emitted for each hop.
- **Diagnostics**: each step stores `lastCheck` (what we asked, what public DNS returned, CAA, edge status, probe result). The seller UI shows expected vs observed, updated live (page refreshes every 8s while in progress).
- **Chains**: each chain carries a `gen` number (Redis `dv:gen:<id>`); a manual re-check or the hourly sweeper starts a new generation and stale delayed jobs of older generations drop themselves. A per-domain Redis lock prevents concurrent steps.
- **Schedules** (worker `domains`): `domains.flush-traffic` every 5 min, `domains.recheck-live` (daily, guarded by a Redis once-key) re-checks active and previously-verified misconfigured domains and deletes never-verified claims older than 7 days, `domains.sweep-stalled` hourly restarts stalled chains.
- **Serving**: `resolveHost(host)` (Redis, tag `host:<host>`, 60s TTL, negative results cached too, invalidated on every state change). Only `active` custom domains resolve. `<slug>.<STOREFRONT_ROOT_DOMAIN>` resolves for live storefronts. The web proxy rewrites to `/store/<slug>/…`, 301s non-primary hosts to the primary (SEO), and skips platform hosts.
- **Primary**: exactly one primary per storefront; the first domain to become active is primary automatically; when a primary exists the free subdomain also 301s to it.

## 2. DNS records

| Host kind | Routing record | Ownership record |
|---|---|---|
| Subdomain (`www.acme.com`) | `CNAME www.acme.com → STOREFRONT_CNAME_TARGET` (default `stores.<root>`) | `TXT _cnote-verify.www.acme.com = cnote-verify=<token>` |
| Apex (`acme.com`) | `A` to each `STOREFRONT_APEX_IPS`, else `ALIAS/ANAME/flattened CNAME` to the CNAME target | same TXT |

Checks use a `node:dns/promises` `Resolver` pinned to public resolvers (`DOMAINS_DNS_RESOLVERS`, default 1.1.1.1, 8.8.8.8), so results match the internet, not a split-horizon resolver. Accepted routing shapes: direct CNAME, CNAME chain (5 hops), or A records overlapping our edge (proxied/flattened). A CAA lookup walks up the tree; if CAA exists and none allows the provider's CA we warn and show the fix (it is a warning, not a hard block, because the provider reports the real failure).

Hostname rules (`validateHostname`): IDNA to ASCII, no scheme/path/port/wildcard, no IPs, no reserved TLDs, not a public suffix (heuristic list; no PSL dependency), no shared-hosting suffixes (vercel.app, github.io…), not our root or platform hosts, max 3 per storefront, globally unique.

## 3. Edge provider matrix (`EdgeProvider` port)

| `EDGE_PROVIDER` | Adapter | Env | TLS | Notes |
|---|---|---|---|---|
| `mock` (default) | in-memory | none | immediately active | dev/CI; HTTPS probe skipped |
| `cloudflare` | Cloudflare for SaaS Custom Hostnames (`/zones/{id}/custom_hostnames`) | `CF_API_TOKEN`, `CF_ZONE_ID` | HTTP DCV, DV cert issued and renewed by Cloudflare | `STOREFRONT_CNAME_TARGET` must be the zone's fallback origin; `active` needs hostname and ssl both active; duplicate (1406) is adopted |
| `vercel` | Vercel Domains API (project domains + `/v6/domains/{d}/config`) | `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` | Let's Encrypt | active = verified and not misconfigured |
| `aws` | documented stub (`edge/aws.ts`) | (future) | ACM DNS validation + CloudFront tenants | design in the file header; Azure Front Door maps the same way |

Adapters are idempotent and use plain `fetch` with a 15s timeout. `getStatus` returning `failed` moves the domain to `misconfigured`; thrown errors are treated as transient and retried.

## 4. Reachability probe

Once the edge reports active, the worker requests `https://<host>/.well-known/cnote-domain-check` and requires the per-host HMAC token (`DOMAIN_CHECK_SECRET`). This proves the request reached our web app through the seller's domain and edge TLS, not merely that DNS looks right. The route only answers for registered hostnames. Disable with `DOMAINS_HTTP_PROBE=off` (also skipped for `mock`).

## 5. Failure modes

| Symptom | Behaviour |
|---|---|
| DNS not propagated | stays `pending_dns`, exponential backoff to hourly, 72h window, then `misconfigured` ("Check again" reopens) |
| Resolver SERVFAIL/timeout on a live domain | treated as transient: status kept, retried in 10 min |
| Records removed later | daily check moves `active → misconfigured`, primary is reassigned, host cache purged; recovers automatically when fixed (previously-verified only) |
| Edge API down | domain stays `verified`, retry in 2 min |
| Certificate not issued in 24h | `misconfigured` with CAA hint |
| Two sellers claim the same host | second add is refused; unverified claims are purged after 7 days; staff can remove in admin |
| Redis down | `resolveHost` fails open to `null` (marketplace served); metering drops hits silently |

## 6. Analytics and privacy

`recordHit` runs from the web proxy: **one Redis EVAL** per request (counters + HyperLogLog + dirty marker), fire-and-forget, never throws.

- **Bots vs humans**: known-crawler UA table (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, Googlebot, Bingbot, facebookexternalhit, …; empty UA and generic HTTP clients count as bots). Bots add to `requests` and `botHits` only.
- **Source** (humans, page loads only): paid (gclid/gbraid/wbraid/msclkid/ttclid/twclid or utm_medium cpc/ppc/paid…), email, AI assistants (chatgpt.com, perplexity.ai, gemini.google.com, claude.ai, copilot.microsoft.com, …), organic search, social (Facebook, Instagram, LinkedIn, WhatsApp, X, YouTube…), referral, direct. AI is matched before search so gemini.google.com is not "google". `fbclid` alone is social, not paid, because Facebook appends it to organic links; it is paid only with a paid utm_medium. In-site referrers are ignored.
- **Uniques**: `sha256(dailySalt | ip | ua)` into a HyperLogLog per storefront per day. The salt is random, stored in Redis for 48h and rotates daily (IST day), so visitors cannot be linked across days. Raw IP and UA are never stored; no cookies. Unique visitors across a range are the sum of daily uniques.
- **Cardinality cap**: pages, referrers and bot names are capped at 3000 distinct fields per storefront per day, the rest fold into `(other)`, so a path-spraying client cannot bloat Redis.
- **Persistence**: `flushTraffic` (every 5 min) SETs today's and yesterday's absolute Redis totals into `StorefrontTrafficDaily`, so replays converge (idempotent). Counter keys live 3 days.
- **Metering**: `requests` counts every request that reaches the proxy for the storefront (assets, bots included); use `getMeteredRequests` for billing.
- **Days** are IST calendar days.

## 7. Environment

`STOREFRONT_ROOT_DOMAIN`, `STOREFRONT_CNAME_TARGET`, `STOREFRONT_APEX_IPS`, `PLATFORM_HOSTS` (extra marketplace hosts, `*.suffix` allowed), `EDGE_PROVIDER`, `CF_API_TOKEN`, `CF_ZONE_ID`, `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID`, `DOMAINS_DNS_RESOLVERS`, `DOMAINS_HTTP_PROBE`, `DOMAIN_CHECK_SECRET` (falls back to `JWT_SECRET`).

## 8. Integration

`apps/web/src/proxy.ts` calls `routeStorefrontHost(req)` then `recordStorefrontHit(req)`; the proxy `matcher` must include every path on non-platform hosts. Storefront pages can read `x-storefront-canonical-host` / `x-storefront-host` request headers and `storefrontCanonical(slug)` for canonical URLs. The `apps/worker` registers `worker` from `@cnote/domains`.
