# Cookie consent manager (buyer web, seller app, storefronts)

Status: implemented. The framework-free core is `@cnote/consent`, the shared banner/dialog is `@cnote/next-kit/consent`; the buyer web
(`apps/web/src/features/consent`) and the seller app (`apps/seller/src/features/consent`) each bind them to their own registry. Admin and studio
have only strictly necessary storage and show no banner (see "Other apps"). Owner: buyer web + seller + `@cnote/compliance` (receipts).
Related: ADR-004 (Bharat-native UX), ADR-010 (compliance), `DESIGN.md` (tokens, a11y), `docs/guides/i18n.md`.

## Why

Before this work the buyer web set non-essential storage (`cnote_vid` visitor id, `cnote_ad_click`, the lead-gen
attribution and nudge-history keys) without asking, and the only banner was a binary analytics prompt that rendered only
when `NEXT_PUBLIC_CLARITY_PROJECT_ID` was set, so a normal first-time visitor was never asked at all.

## Standards applied

| Standard | What we took from it |
|---|---|
| **DPDP Act 2023 s.5** (notice), **s.6** (consent: free, specific, informed, unconditional, unambiguous, clear affirmative action; **s.6(4)** withdrawal as easy as giving; **s.6(10)** burden of proof on the Data Fiduciary), **s.7(a)/(b)** (no consent needed for what the user asked for), **s.8(7)** (storage limitation) | Banner names the data fiduciary and links the notice; per-purpose consent; withdrawal from the footer without reload; a stored consent receipt as proof (retained 3 years, then purged); strictly necessary storage exempt. |
| **DPDP Rules 2025 r.3** (notice: clear, plain language, itemised description of the personal data and purposes, how to withdraw and to complain) | Short plain first layer, itemised second layer + policy page (name, provider, purpose, duration of every key), how to withdraw, grievance link. Language follows the page (en/hi live; other catalogues drafted). |
| **GDPR Art 4(11), 7** and **ePrivacy Directive Art 5(3)** | Prior opt-in for anything non-essential (cookies **and** localStorage/sessionStorage, and third-party scripts); nothing pre-ticked; scrolling or continuing is not consent; Art 7(1) proof and Art 7(3) easy withdrawal. |
| **EDPB Cookie Banner Taskforce report (Jan 2023)** | "Reject all" on the first layer, Accept and Reject with equal visual prominence, no cookie wall, no dark patterns, no pre-ticked boxes, no "legitimate interest" for tracking. |
| **CNIL cookie guidance** | Consent choice is re-asked after **12 months** (CNIL maximum is 13); the refusal is remembered as long as an acceptance. |
| **Global Privacy Control** (CCPA/CPRA regs 11 CCR 7025) | `navigator.globalPrivacyControl === true` or `Sec-GPC: 1` treats marketing as opted out: "Accept all" grants analytics and preferences but not marketing; the user can still switch marketing on explicitly. GPC never affects the `functional` category (it is not a sale/share signal). Recorded in the receipt. |
| **WCAG 2.2 AA** | Region landmark (not a fake dialog) for the banner; native `<dialog>` + `showModal()` (focus trap, Esc, inert page); switches are `role="switch"` with `aria-checked` and visible On/Off text; 44px targets; visible focus; 2.4.11 Focus Not Obscured handled by reserving the banner height; `prefers-reduced-motion`; scrollable tables are focusable regions. |

## UX (Mobbin reference)

Second layer follows SchoolAI's cookie preferences pattern
(<https://mobbin.com/screens/915ef29e-f471-44b7-bb48-dba81aea56b6>): a modal titled "Cookie preferences", accordion
categories, an "Always active" label for strictly necessary, toggles for the others, and **Accept all / Reject all / Save
choices** in a sticky footer. Adopted: the accordion + toggle structure and footer action set. Changed: the toggles are
never pre-set (SchoolAI-style defaults would fail Art 4(11)), Accept and Reject are visually identical, and each accordion
expands to a real table (name, provider, purpose, duration) rendered from the registry.

First layer: a bottom, non-modal `<section aria-label>` with one short paragraph and three identical buttons (Accept all,
Reject all, Customise). It is `position: fixed`, so page content never shifts; while it shows, `<html data-consent-banner>`
plus `--consent-banner-h` add bottom padding and `scroll-padding-bottom` (see `globals.css`) so the footer is reachable and
no focused control hides behind it. It is read from the cookie after mount, so the static public pages stay static and there is
no hydration mismatch.

## Categories

| Category | Consent | What |
|---|---|---|
| Strictly necessary | none (always on) | sign-in/security, and things the user explicitly asked for or dismissed |
| Analytics | opt-in | Microsoft Clarity (loaded only after opt-in; masked forms; never `identify`) |
| Marketing and attribution | opt-in | visitor id, ad-click attribution, UTM/referrer attribution, lead-gen nudge history |
| Preferences and personalisation (`functional`) | opt-in, default off | things that make the site easier but the visitor did not explicitly ask for, e.g. the "Recently viewed" rail. Consent is specific to this purpose (DPDP s.6(1), EDPB 05/2020 granularity), so it is NOT bundled into marketing. "Accept all" grants it; Global Privacy Control does not affect it |

### Cookie / storage classification

| Key | Kind | Category | Provider | Duration |
|---|---|---|---|---|
| `cnote_consent` | cookie | necessary | first party | 12 months |
| `cnote_consent_pending` | localStorage | necessary (the consent record itself: a receipt not yet acknowledged by the server, deleted after a 200) | first party | until acknowledged |
| `cnote_consent_sync` | sessionStorage | necessary (the consent record itself: "this visit's choice was checked against the account") | first party | session |
| `cnote_web_at` / `cnote_web_rt` (prefixed `__Host-` in production) | httpOnly cookie | necessary | first party | 15 min / 30 days |
| `cnote_web_oauth`, `cnote_web_mfa` | httpOnly cookie | necessary | first party | 10 min / 5 min |
| `cnote_locale` | cookie | necessary (explicit language choice) | first party | 1 year |
| `cnote_rail` | cookie | necessary (UI state the user toggled) | first party | 1 year |
| `cnote_pincode` | cookie | necessary (delivery pincode the user entered) | first party | 1 year |
| `cnote_compare` | cookie | necessary (the user's compare tray) | first party | 7 days |
| `cnote_lang_suggestion_dismissed` | localStorage | necessary (user dismissed a banner) | first party | until cleared |
| `cnote_voice_consent_v1` | localStorage | necessary (records the user's own consent to voice search) | first party | until cleared |
| `_clck`, `_clsk`, `CLID`, `ANONCHK`, `MR`, `MUID`, `SM` | cookies | analytics | Microsoft Clarity | 1 year / 1 day / 1 year / 10 min / 7 days / 1 year / session |
| `cnote_vid` | cookie (client, and httpOnly from ad routes) | marketing | first party | 30 days |
| `cnote_ad_click` | httpOnly cookie | marketing | first party | 7 days |
| `cnote_attr` | sessionStorage | marketing | first party | session |
| `cnote_lg_v1` | localStorage | marketing | first party | until cleared |
| `cnote_lg_views`, `cnote_lg_session` | sessionStorage | marketing | first party | session |
| `cnote_recent_v1` | localStorage | **functional** (recently viewed product ids, device only; see `docs/design/buyer-convenience.md`) | first party | until cleared (entries expire after 30 days) |

## Single source of truth

`features/consent/registry.ts` lists every key with category, provider, purpose message key and duration. The preferences
dialog, the cookie policy page (`/cookies`, static, en + hi) and the withdrawal cleanup all read it.
`test/consent-registry.test.ts` fails when code under `apps/web/src` mentions a quoted `cnote_*` key that is not in the
registry, and checks the shared-package cookies (auth, OAuth/MFA challenge, compare tray) are listed.

## Consent record (cookie)

`cnote_consent` = URL-encoded `v=3&id=<32 hex>&a=1&m=0&f=0&t=<unix s>&gpc=0`, first party, `Path=/`, `SameSite=Lax`, `Secure` on
https, **not** httpOnly (client islands read it), `Max-Age` = 12 months. Pure `parseConsent`/`serializeConsent`
(`features/consent/state.ts`) are shared by client and server. `t` is strictly increasing per consent id (`buildConsent`), because
the server dedupes receipts on `(id, t)`. A missing, malformed, expired (over 12 months), future-dated
or older-`CONSENT_POLICY_VERSION` value, and the legacy `granted`/`denied` values, all mean "no choice": ask again.

`cnote:consent` (window event, `detail` = the state) fires on every change so islands react without a reload; Clarity, the
manager and the leadgen helpers listen or re-read the cookie.

## Gating

- Clarity loads only with `analytics` granted; `consentv2.ad_Storage` follows `marketing`. On withdrawal Clarity is told
  `denied`, `_clck`/`_clsk` are expired on the host and every parent domain, and the script is not loaded again.
- Client: `getVisitorId()`, `captureAttribution()` and the nudge store write nothing unless `marketing` is granted; without it
  the visitor id is in memory and the nudge caps live in memory for that page load (features keep working, they just do not
  remember). Without marketing consent no UTM/referrer is collected.
- Server: `/ad/[token]`, `/api/ads/similar`, `loadSponsoredForResults` and `attributeEnquiryFromCookie` call
  `requireConsent(req | cookieStore, "marketing")` from `features/consent/server.ts` (the one helper; do not inline the cookie
  parse again). Without `marketing` they neither set nor read `cnote_vid`/`cnote_ad_click` (the click is still recorded and the
  redirect still works).
- Withdrawal (`applyConsent` in `client.ts`): writes the new cookie, deletes the category's client-clearable cookies and
  storage keys, emits the event, then `POST /api/consent`, which also expires the httpOnly `cnote_vid`/`cnote_ad_click`.

## Proof of consent (receipt)

`POST /api/consent` (same-origin, JSON, at most 2 KB, 30 requests per 10 min per `clientIp()`; fails open if Redis is down)
appends a `CookieConsentReceipt` (`packages/db/prisma/schema/compliance.prisma`, written by `recordCookieConsent` in
`@cnote/compliance`):

| Column | Meaning |
|---|---|
| `consent_id` | random 32 hex from the browser's `cnote_consent` (a browser, not a person) |
| `policy_version` | `CONSENT_POLICY_VERSION` the notice was at |
| `analytics`, `marketing`, `functional` | per-category choice (necessary is always on and needs no consent); `functional` is `false` on rows from before it existed and when an older browser build omits it |
| `gpc` | Global Privacy Control was on (cookie flag OR `Sec-GPC: 1`) |
| `action` | `accept_all` / `reject_all` / `custom` / `withdraw` (any switch-off of something granted is `withdraw`) |
| `locale` | language the notice was shown in |
| `person_id` | only when signed in (existing session helper); nullable, no FK (module boundary) |
| `client_at` | the browser's `t` (unix seconds). Unique with `consent_id`: **`POST /api/consent` is idempotent**, a resend is `ON CONFLICT DO NOTHING` and answers 200 with the stored row |
| `registry_hash` | sha256 of the committed policy snapshot of `policy_version` (see "Policy version snapshots"), computed server-side; null on rows from before v2 |
| `created_at` | server time (authoritative) |

**No IP address and no user agent are stored** (data minimisation); the IP is only the rate-limit key. Rows are append-only.
Validation is strict (zod, unknown keys rejected, action consistent with the choices).

**Retention: 3 years** (`compliance.cookie_consent_receipts`, env `RETENTION_COOKIE_CONSENT_RECEIPTS_DAYS`). The receipt must
outlive the consent it evidences so we can meet the s.6(10) burden of proof; 3 years matches the general limitation period
(Limitation Act 1963, art. 113) in which a dispute could be raised, and s.8(7) forbids keeping it longer. Pending counsel
review, like the other retention windows.

**Erasure (DPDP s.12(3), s.8(7)).** The receipt carries no direct identifier (no IP, no user agent), only a random browser id.
When an erasure request is resolved (`respondToGrievance`, request type `erasure`), `anonymizeCookieConsentReceipts` sets
`person_id = NULL` on that person's receipts in the same transaction and keeps the rest: the anonymous proof of what a browser was
told and chose, which we may retain to demonstrate compliance until the 3-year purge. This is the single deliberate exception to
"append-only". The identity ledger rows for `analytics_cookies` / `marketing_cookies` / `functional_cookies` are withdrawn by `erasePerson` like every
other purpose. Counsel to confirm.

### Reliable receipts

A receipt must not be lost to a dropped connection, a closed tab or a 5xx (s.6(10) puts the burden of proof on us):

1. `applyConsent` writes the receipt to `localStorage["cnote_consent_pending"]` (an array, at most 20) BEFORE posting it.
2. It is removed only when the server answers 200 (or a permanent 4xx: 400/403/413/415, which a resend cannot fix). Network failure,
   408, 429 and 5xx leave it in place.
3. On the next page load `ConsentManager` calls `flushPendingReceipts()`; the server dedupes on `(consent_id, client_at)`, so
   resending is always safe (the browser may also have retried successfully while the 200 was lost).

`cnote_consent_pending` is registered as **strictly necessary**: it is the consent record itself, holds only the choice and consent
id, and is deleted once the server has it.

### Policy version snapshots

`features/consent/policy-snapshots/v<N>.json` is committed for every `CONSENT_POLICY_VERSION`: the full storage registry plus the
en/hi notice and category strings (`NOTICE_KEYS` in `policy.ts`: banner, dialog, category copy, tables, proof text). `registry_hash`
on a receipt is the sha256 of that snapshot (canonical JSON: sorted keys), so years later we can show exactly what the visitor saw.
`test/consent-policy-snapshot.test.ts` fails when the live registry or those strings differ from the snapshot of the current
version, with instructions: bump `CONSENT_POLICY_VERSION` + `CONSENT_POLICY_UPDATED`, run
`UPDATE_CONSENT_SNAPSHOT=1 pnpm --filter @cnote/web exec vitest run test/consent-policy-snapshot.test.ts` (writes only a MISSING file;
`overwrite` is for a version that has not shipped), register it in `POLICY_SNAPSHOTS`. Never edit an older snapshot. The other six
locales are not snapshotted (machine-drafted, not live on the web).

### Consent ID and "Download my consent record"

The preferences dialog and `/cookies` show **"Your consent ID: …"** (the id from the visitor's own cookie) with a Copy button
(confirmation in a polite live region) and **Download my consent record**, a link to `GET /api/consent/receipt`: same origin
(`Sec-Fetch-Site`), keyed ONLY by the consent id in the cookie (so nobody reads another browser's record), `Cache-Control: private,
no-store`, `Content-Disposition: attachment`, 30 requests per 10 minutes per IP. The JSON lists, per receipt: recorded and choice time,
action, both choices, GPC, policy version, registry hash, language and whether the visitor was signed in; never the person id or an
internal row id. The id is read even from an expired or older-version record so a visitor can still fetch their history. The
grievance form has an optional consent-ID field, prefilled from the cookie; the ticket stores it (`consent_id`) and the admin queue links
it to the consent log.

### Account sync (signed-in people)

- **Write.** When `POST /api/consent` is called by a signed-in person it mirrors the choice into the identity consent ledger through
  `@cnote/identity`'s public `setConsent` (purposes `analytics_cookies`, `marketing_cookies`, `functional_cookies`; source `web_cookie_banner`), only for
  purposes that changed. The ledger write is best effort and never fails the receipt. Account forms skip these two purposes
  (`saveConsentsAction`), so saving the account page cannot withdraw them.
- **Read.** `ConsentManager` (a client island, once per page load) calls `GET /api/consent/account` (`{signedIn, analytics:{granted,at},
  marketing:{...}}`, no DB read for anonymous visitors) when there is no valid cookie, or once per visit (`cnote_consent_sync`), and
  applies `reconcileAccountConsent`: with no valid cookie it seeds one from the ledger (unless the ledger is older than 12 months);
  with a cookie, per purpose the **newer** of cookie and ledger wins, so a withdrawal on one device beats an older grant on
  another. Adopting goes through `applyConsent` (cookie, cleanup of withdrawn storage, event, a receipt with the ledger's time).
  next-kit's auth core is untouched.
- **Clock skew.** Ledger time is server time, the cookie's is the browser's. On write a choice made within 5 minutes of the server
  clock counts as "now"; a late resend of an offline receipt keeps its own (older) time, so it cannot overwrite a newer choice made
  elsewhere.
- **Known limit.** A choice made while signed out is copied to the ledger only at the person's next change (a signed-in resend of
  the same receipt is not attempted), and sign-in followed by client-side navigation syncs at the next full page load.

### Admin consent log

`/compliance/consent` in `apps/admin` (privilege **`compliance.consent`**: `ops_moderator` and `super_admin`; the tab is hidden
without it): search by consent ID or person ID, filters for date range (IST days), policy version and action, keyset pagination on
`(created_at, id)`, summary metrics (action mix per IST day, per language, Global Privacy Control share; observational only, no
experiments) and **Export CSV** (`/compliance/consent/export`, streamed in keyset pages, capped at 250k rows, formula-injection safe).
Every search and every export goes through `audited()`, with the filters in the audit details; an export also audits its completion
with the row count. The functions live in `@cnote/compliance`: `searchCookieConsentReceipts`, `iterateCookieConsentReceipts`,
`cookieConsentStats`.

### Runtime cookie audit (e2e)

`e2e/a11y/cookie-audit.spec.ts` loads home, search, a product page and `/cookies` in three states (no choice, Reject all, Accept all)
and fails when `context.cookies()`, `localStorage` or `sessionStorage` hold a key that is not in the registry (imported from
`features/consent/registry.ts`, with the `__Host-` prefix stripped), or when anything non-necessary exists after "no choice" or
Reject all. It complements the source-grep unit test, which cannot see what the browser actually stores.

## Adding a cookie or storage key

(Buyer web. For the seller, admin and studio apps see "Other apps"; the steps are the same with that app's registry file.)

1. Add the entry to `STORAGE_REGISTRY` (`registry.ts`): name exactly as written by code, category, kind, provider, purpose
   key, duration (and `httpOnly` / `alsoServerSet` if the server writes it).
2. Add `consent.purpose.<key>` (and any new duration/provider key) to **all 8** `apps/web/messages/*.json` catalogues.
3. Non-essential keys must call `clientGranted("analytics" | "marketing" | "functional")` (client) or read `cnote_consent` from the request
   (server) before writing. Strictly necessary keys need a one-line justification in the registry comment.
4. **Bump `CONSENT_POLICY_VERSION` and `CONSENT_POLICY_UPDATED` (`state.ts`) and add a snapshot** (see "Policy version snapshots")
   whenever the registry or a notice string changes. The snapshot test enforces this, so a bump now accompanies even a strictly
   necessary key or a reworded purpose; a bump asks everybody again, which is the safe default for proof.
5. `pnpm --filter @cnote/web test` (registry completeness and the snapshot) must pass.

## Feature flag: `STOREFRONT_EMBEDS_ENABLED` (default off)

The embed block is a seller-facing feature whose content is **not moderated yet** (ADR-003: all seller content is moderated), so it ships dark
(documented in `.env.example`). While the flag is off:

- Studio does not offer the block (the editor gets the flag as a server prop and filters "Add section").
- `@cnote/storefront` rejects it server-side: `saveDraft`, `replaceDraft` (templates / AI builders), `restoreVersion` and `publish` throw a `validation`
  error ("Video and map blocks are not available yet. Remove them to continue.") for any document that contains one. The schema itself still accepts
  the block, so documents already stored keep loading.
- A stored document that already has an embed block renders **nothing** for it (no heading, no link, no frame), on the web and in Studio's preview.
- `ConsentGate`, `StoreEmbed`, the CSP `frame-src` hosts and the iframe lint test stay as they are (they are inert without the block).
- The buyer-web consent notice stays at **policy v3**: the only notice change in this work is the embeds sentence, so with the flag off nobody
  is re-asked. `CONSENT_POLICY_VERSION = EMBEDS_ENABLED ? 4 : 3` and `embedsNote` is in `NOTICE_KEYS` only with the flag on (`v3.json` is untouched,
  `v4.json` is the flag-on snapshot; the snapshot test passes in both modes).

Runtime vs build time: the server checks read the runtime env; the consent code runs in the browser, so the web inlines the flag at build time
(`apps/web/next.config.ts` `env`). Turning the feature on therefore needs a rebuild of the web, and **is** a notice change: the re-prompt to v4 is
intended, because the marketing and preferences categories then also cover embedded third-party content.

e2e: the flag is on only for `e2e/a11y/storefront-embed.spec.ts`, which runs in its own Playwright project against a second web build
(`.next-embeds`, `STOREFRONT_EMBEDS_ENABLED=1`, port 3006); every other spec runs with the flag off like production.

### Moderation follow-up (before the flag is turned on)

1. Resolve the video's title (YouTube oEmbed: `https://www.youtube.com/oembed?url=...`, title + author, no API key) when the seller saves the block and
   run it, with the block title, through `ai.moderate` (ADR-008: log prompt version and model, route low confidence to the ops queue). Block saving on a
   `block` verdict; map blocks need only the title.
2. Add the embed block to `collectText` for the publish pre-screen (title is already there) and send any storefront with an embed to **staff review**
   (`in_review`) regardless of the AI verdict, until the false-positive rate is known.
3. Re-check the oEmbed title periodically (the video can change after approval) and unpublish the block on a `block` verdict.

## Policy version 4 (embeds, only with the flag on)

Adds the sentence about third-party embeds (`consent.embedsNote`, in `NOTICE_KEYS`) to the dialog and `/cookies`, so the snapshot is `policy-snapshots/v4.json`
and everybody is asked again. No registry entry changed: YouTube and OpenStreetMap set their own cookies on their own hosts and only after the gate
opens, so they are disclosed (provider named at the point of use and in the notice) rather than listed as our keys.

## Judgment calls

- The banner is rendered right after the skip link (before the header), so keyboard and screen-reader users meet the
  notice first while "Skip to content" stays the first Tab stop (WCAG 2.4.1). It is a region, not a dialog, and never
  steals focus; visually it is fixed to the bottom of the viewport.
- The Analytics category is always listed, even when `NEXT_PUBLIC_CLARITY_PROJECT_ID` is unset, so the notice, the policy
  page and the receipt do not change with configuration.
- `cnote_vid` is now 30 days on the client as well (it was 1 year), matching the server-set cookie.
- A receipt that fails to save does not block the choice; the cookie is authoritative for behaviour and the receipt is kept in
  `localStorage` and resent on every load until the server acknowledges it (see "Reliable receipts"). Failed writes are logged
  (`[web] /api/consent failed`).
- The other six catalogues (kn ta te mr gu bn) are machine-drafted like the rest of those catalogues and need native review.

## DPDP rights requests (grievance flow)

`/grievance` takes a **request type** (`REQUEST_TYPES` in `@cnote/compliance`): `access`, `correction`, `erasure`, `nomination`,
`withdraw_consent` (DPDP ss.11-14 and s.6(4)) or `complaint` (content, consent handling or anything else; the form then asks for a
category). Rights requests carry a **90-day SLA** (`GRIEVANCE_RIGHTS_REQUEST_DAYS`, default 90, DPDP Rules 2025); complaints keep
the grievance SLA (15 days). Both keep the 24-hour acknowledgement window. The ticket stores `request_type`, `sla_days` (fixed at
filing), the derived routing `category` and the optional cookie `consent_id`. The account list shows the type; the admin queue has a
"Data rights requests" filter, the SLA kind and days left, the consent-ID link and an erasure note. Resolving an `erasure` request
detaches the person's cookie-consent receipts (see "Erasure" above).

## Deliberate choices

- **Global opt-in, no geo variants.** Everybody gets the same opt-in banner (nothing optional before a clear affirmative act).
  We do not geolocate to relax it for some regions: DPDP s.6 needs it in India and it is also the GDPR/ePrivacy standard; one
  behaviour is simpler to prove and to test.
- **Google Consent Mode: not applicable until a Google tag exists.** No Google tag, GA or Ads script runs today. When one is added,
  set the defaults to `denied` before the tag loads and `gtag('consent','update', ...)` on every choice and on load from the
  cookie, mapping: `analytics_storage` = `analytics`; `ad_storage`, `ad_user_data`, `ad_personalization` = `marketing`;
  `functionality_storage`, `personalization_storage`, `security_storage` = granted (strictly necessary, or the user's own explicit
  setting). Add the provider's keys to the registry and bump the policy version first. (Clarity's own `consentv2` call is already
  mapped the same way.)
- **Do Not Track is not honoured; Global Privacy Control is.** DNT was never standardised and is deprecated; GPC is a legal
  signal in some regimes and cheap to honour (marketing off by default), so we honour GPC and record it on the receipt.
- **IAB TCF: not applicable.** We run no programmatic advertising and share no data with ad-tech vendors, so there is no vendor
  list or TC string. Revisit if that changes.
- **Children's data: not applicable.** The product is B2B for registered businesses; we do not target or knowingly serve people under
  18 (DPDP s.9 verifiable parental consent and the ban on tracking children are not triggered). Revisit if a consumer surface is added.

## Other apps (seller, admin, studio, storefronts)

Cookies are host-scoped and the apps are deployed on separate hosts, so **each app has its own consent record, registry, policy version
and snapshots**. Only an app with optional storage shows a banner.

### Storage audit

Method: grep of every app's `src` for cookie writes (`cookies().set`, `res.cookies.set`, `Set-Cookie`, `document.cookie`), `localStorage`,
`sessionStorage`, `indexedDB`, `next/script` / created `<script>`, `<iframe>`, plus each app's Sentry and Clarity configuration, and the cookies
that `@cnote/next-kit` and `@cnote/identity` write for the app's auth realm. The tests below keep the table true.

| App | Key / script | Kind | Written by | Class | Gate / notes |
|---|---|---|---|---|---|
| **seller** (`apps/seller`) | `cnote_seller_at`, `cnote_seller_rt` (`__Host-` in prod) | httpOnly cookie, 15 min / 30 days | next-kit auth | necessary | sign-in and session |
| seller | `cnote_seller_oauth`, `cnote_seller_mfa` | httpOnly cookie, 10 min / 5 min | next-kit | necessary | Google round trip and pending two-step sign-in |
| seller | `seller_locale` | httpOnly cookie, 1 year | language switcher; onboarding | necessary | the language the seller chose (first business language at onboarding) |
| seller | `seller_onb_done`, `seller_onb_skip_gst`, `seller_onb_skip_listing` | httpOnly cookie, 1 year | onboarding actions | necessary | the seller's own "finished" / "skip this step"; without them onboarding would ask again |
| seller | `seller_onb_t1` | httpOnly cookie, 1 year | first listing submitted | necessary | the seller's own action "I submitted my first listing" (and when): shows the outcome for two minutes and stops it being counted twice. State of something the seller did, not measurement |
| seller | `seller_onb_t0` | httpOnly cookie, 1 year | business created | **analytics (optional)** | start time for the onboarding-duration metric (ADR-004: time to first listing and to finishing). Written only with `analytics`; without it the events are still logged, with no timing |
| seller | `seller_ref` | httpOnly cookie, 30 days | proxy from `?ref=`; `/api/consent/ref` | **marketing (optional)** | referral attribution (ADR-025). Written only with `marketing`; a grant made after landing hands the code over from the address bar |
| seller | `seller_consent` | cookie, 12 months | consent manager | necessary | the consent record |
| seller | `seller_consent_pending` | localStorage | consent manager | necessary | receipt not yet acknowledged, deleted after a 200 |
| seller | Cloudflare Turnstile (`challenges.cloudflare.com`, only when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set) | third-party script + frame on the auth forms | next-kit | necessary | bot protection on sign-in / sign-up (security of a service the seller asked for). No other page loads it |
| seller | Sentry browser SDK | no cookie, no web storage; sends scrubbed error events | `instrumentation-client.ts` | necessary (service integrity) | `sendDefaultPii: false`, PII scrubbing in `@cnote/observability`, **no session replay and no tracing integration** (a test fails if one is added) |
| seller | Microsoft Clarity | not loaded | n/a | n/a | Clarity is buyer web only (CSP and code) |
| **admin** (`apps/admin`) | `cnote_admin_at`, `cnote_admin_rt`, `cnote_admin_oauth`, `cnote_admin_mfa` | httpOnly cookies, 5 min / 12 h / 10 min / 5 min | next-kit auth | necessary | staff sign-in. **No banner** |
| admin | template preview `<iframe srcDoc sandbox="">` | sandboxed same-document preview | template studio | n/a | no `src`: nothing is loaded from anywhere |
| admin | Sentry browser SDK | no storage | `instrumentation-client.ts` | necessary | as above |
| **studio** (`apps/studio`) | `cnote_seller_at`, `cnote_seller_rt`, `cnote_seller_oauth`, `cnote_seller_mfa` | httpOnly cookies | next-kit auth (seller realm, studio's own host) | necessary | seller sign-in. **No banner**. The editor keeps drafts on the server, nothing in localStorage |
| studio | Sentry browser SDK | no storage | `instrumentation-client.ts` | necessary | as above |
| **storefronts** (`/store/[slug]`, custom domains, `<slug>.<root>` subdomains) | everything the buyer web sets (see the table above) | | | | Storefront pages are rendered by the buyer web under its root layout, so they carry the **same banner, registry and gating** as any buyer page. The platform is the data fiduciary for these cookies. A seller cannot add storage: the document model has no script, style or HTML block |
| storefronts | Microsoft Clarity | script | buyer web `<Analytics />` | analytics | loads only when `NEXT_PUBLIC_CLARITY_PROJECT_ID` is set **and** `analytics` is granted, on a storefront exactly as on any page (e2e: no `_cl*` before consent) |
| storefronts | `cnote_vid`, `cnote_ad_click`, `cnote_attr`, `cnote_lg_*` | | buyer web | marketing | only after `marketing`; the storefront's RFQ link goes to the marketplace, where the lead-gen helpers are gated the same way |
| storefronts | traffic metering (`@cnote/domains`) | none on the device | proxy, server side | n/a | counts requests and a daily-salted SHA-256 of IP + user agent in a HyperLogLog; no cookie, no storage, raw IP/UA never stored |
| storefronts | YouTube (`youtube-nocookie.com`) and OpenStreetMap frames | third-party iframe | `embed` block | **marketing** / **functional (optional)** | behind `<ConsentGate>` (see below); nothing is requested before the visitor allows the category or chooses "Load it" |

Result: **two apps have optional storage and get a banner** (buyer web, already; seller, new). **Admin and studio have only strictly necessary
storage, so they get no banner**; instead each has a registry and a test that fails the day optional storage appears.

### Why a package, and which one (ADR-006)

The consent core is browser-and-server logic with no framework: the cookie format (`parseConsent` / `serializeConsent`, 12-month expiry, policy
version), categories, the registry types and helpers, Global Privacy Control, the receipt outbox (`applyConsent`, `flushPendingReceipts`),
withdrawal cleanup, policy snapshot hashing and the source scanners for the registry tests. It is a new leaf package, **`@cnote/consent`**
(`ALLOWED_DEPS`: none, no react, no next, no database), not a `next-kit` module, because three of its four users (the registry tests of admin and
studio, the compliance receipts, the snapshot hashing) must not pull in Next, and because `next-kit` already sits on top of many modules.

The React pieces are framework code and sit where framework glue belongs, **`@cnote/next-kit/consent`** (banner, preferences dialog, cookie table,
switch, consent record, settings button, `ConsentManager`) and **`@cnote/next-kit/consent-route`** (the shared `POST /api/consent` handler, with
the receipt writer injected because `@cnote/compliance` sits above the domain modules and `next-kit` may not depend on it). The buyer web's old
files are now thin wrappers that bind them to the web's registry, site name and consent-record download, so its tests and imports did not move.
Messages stay in each app's own `consent` namespace (a shared component needs the same keys in both apps).

What is per app: cookie name (`cnote_consent` vs `seller_consent`, so a shared `localhost` in dev and e2e cannot cross-read), policy version, registry,
snapshots (`policy-snapshots/v<N>.json`), notice strings, and which categories are offered. The dialog only lists categories that have at least one
registry entry (`categoriesOf`): a switch that controls nothing would be a dark pattern, so the seller dialog has no "Preferences and personalisation".

### Receipts: the `app` column

`compliance.cookie_consent_receipts.app` (`text not null default 'web'`, migration `cookie_consent_app`; all earlier rows are the buyer web).
The browser never sends it: `createConsentPost({ app })` supplies it server side and the strict body schema rejects an `app` key. `policy_version` and
`registry_hash` are per app. The admin consent log has an App filter and column, and the CSV export an `app` column. Retention, erasure and the
other columns are unchanged. The seller route does not mirror choices into the identity consent ledger (the buyer web does, for signed-in people):
a seller's choice is per device.

### The seller app

`seller_consent` (cookie `v=1&id=&a=&m=&f=0&t=&gpc=`), registry `apps/seller/src/features/consent/registry.ts`, banner and dialog from
`@cnote/next-kit/consent` mounted in the root layout, a "Cookie settings" link in the landing footer, the auth layout and the portal shell, receipts at
`POST /api/consent` (same-origin, same limits as the buyer web). Gating:

- `writeOnb()` (`apps/seller/src/lib/cookies.ts`) writes `seller_onb_t0` only with `analytics`; the metric events are logged either way, with `timeToFirstListingMs` / `totalMs` null when there is no start time. (`seller_onb_t1`, "I submitted my first listing", is necessary: gating it broke the "Submitted for review" confirmation, which the full e2e run caught.)
- `proxy.ts` stores `seller_ref` only with `marketing`. A visitor who accepts after landing on `/?ref=CODE` is covered: the manager posts the code
  to `/api/consent/ref`, which stores it only when the consent cookie says `marketing` and the code matches `^[A-Za-z0-9_-]{4,64}$`.
- Withdrawal expires the httpOnly cookies of every category not granted (`createConsentPost`, from the registry's `httpOnly` entries).
- The banner has no cookie-policy page to link to (the seller app has none); its text says to choose Customise, where the full table of names, purposes
  and durations is the notice. A seller policy page is a follow-up.

### Admin and studio: necessary only, enforced

`apps/admin/src/lib/storage-registry.ts` and `apps/studio/src/lib/storage-registry.ts` list the auth cookies. Their tests (`storage-registry.test.ts`)
run `auditNecessaryOnlyApp` from `@cnote/consent/testing` and fail when: the registry holds a non-necessary entry, source mentions an unregistered
`cnote_admin_*` / `cnote_seller_*` key, source writes a cookie or uses `localStorage` / `sessionStorage` / `indexedDB` outside the listed files,
loads a third-party script, or renders an iframe with a third-party `src`; and when Sentry gains a replay or tracing integration. The failure message
says what to do: add a banner (copy the seller's), gate the write, bump the policy version. Do not edit the test to make it pass.

### Seller registry and runtime tests

`apps/seller/test/consent-registry.test.ts` (registry completeness against the source, the realm's auth cookies, classification, no unaccounted
storage writes, no scripts or iframes, Sentry settings), `consent-gating.test.ts` (optional cookies are written only with their category; the seller
does not read the buyer's cookie; `/api/consent/ref`), `consent-policy-snapshot.test.ts` (proof of what was shown), and the e2e
`e2e/functional/seller-cookie-consent.spec.ts` (banner, equal buttons, nothing optional before opt-in, receipt stored with `app = 'seller'`, referral
handling, withdrawal, GPC, Hindi, and a runtime audit of the browser's real cookies and storage).

## Consent gate for third-party embeds

`<ConsentGate category="marketing|analytics|functional" provider="YouTube">…</ConsentGate>`
(`apps/web/src/features/consent/consent-gate.tsx`). Until the category is granted it renders an accessible placeholder, a labelled group with
"This content is from {provider}, which may set cookies.", **Load it** and **Change cookie settings** (real buttons, 44px targets, en/hi and the
six other catalogues), and **does not create the children**: no iframe, so no request to the provider, no cookie, no IP disclosure.

- The consent cookie is read after hydration (`useSyncExternalStore`), so the static pages stay static and the first client render matches the server.
- Granting the category in the dialog loads every embed of that category **live** (the `cnote:consent` event); withdrawing removes them again.
- **Load it** shows that one item for this page view. It is a specific, informed act for one named provider (DPDP s.6(1); EDPB 05/2020), not a stored
  choice: it writes nothing and the banner keeps asking. After the click focus moves to the loaded content.
- The cookie notice names the embeds (`consent.embedsNote`, in the dialog and on `/cookies`) **only while the feature flag is on**; that sentence is why the policy moves to **version 4** then (see "Feature flag").

Where it is used: the storefront **`embed` block** (new; there were no third-party iframes in the codebase before). A seller picks a **YouTube video**
(paste a link; we keep only the 11-character id, `youtubeIdFromInput`) or a **map** (latitude, longitude, zoom). The seller never supplies a URL or HTML:
`embedSpec()` (`@cnote/storefront/document`) builds the iframe URL from a fixed privacy-enhanced host, `youtube-nocookie.com/embed/<id>` or
`openstreetmap.org/export/embed.html?bbox=…`, and names the provider and category: video is **marketing** (a video platform profiles viewers), a plain
map tile server is **functional** (GPC does not affect it). The renderer never emits an `<iframe>` itself: it hands an `Embed` component the spec.
The buyer web passes `StoreEmbed` (`<ConsentGate>` around the sandboxed, lazy iframe); Studio's preview and any host without a gate get a plain link
("Factory tour: open on YouTube"), never a frame.

**CSP.** `frame-src` on the buyer web is exactly `https://www.youtube-nocookie.com https://www.openstreetmap.org` (plus Turnstile when configured), and
`'none'` on seller, admin, studio and api (`EMBED_FRAME_ORIGINS` in `@cnote/security`; `buildCsp({ embeds })`). The regular `youtube.com` is never framed.
A web test asserts the security package's list equals the storefront's and that every URL `embedSpec` builds is inside the CSP.

**Enforcement.** `apps/web/test/consent-gate.test.tsx` scans every `src` in `apps/*` and `packages/*` and fails when an `<iframe` with a
third-party or dynamic `src` is not inside `<ConsentGate>…</ConsentGate>` (`findUngatedIframes`), and pins the full list of such frames to the one in
`StoreEmbed` (the only others are the admin template preview, a sandboxed `srcDoc` with no `src`). e2e `e2e/a11y/storefront-embed.spec.ts` (provider
hosts stubbed): placeholders and the banner before consent with no request to either host and axe clean; Load it loads one item through the nocookie
host and leaves the cookie alone; Change cookie settings then Save loads it live without a reload; Accept all loads both and survives a reload;
withdrawing marketing removes the video; Reject all keeps both gated; preferences-only loads the map but not the video; GPC loads the map but not the
video; no CSP violation anywhere.

### Storefront pages on custom domains

A storefront on its own domain (or `<slug>.<root>`) is the buyer web serving a rewritten path, so it shows the same banner. Its consent cookie is
host-only, so **each custom domain asks separately**, and receipts post to that host's `/api/consent` (`/api/` passes through the host router untouched).
The banner's "Cookie policy" link would resolve inside the storefront (`/cookies` is rewritten to `/store/<slug>/cookies`), so on a host that is not the
marketplace origin it links to `${APP_URL}/cookies` instead (`ConsentManager siteOrigin`).

## Preferences and personalisation (`functional`), policy version 3

Added with the buyer convenience features. Cookie format gains `f=0|1`; a cookie without `f` parses as "not granted" (and the version bump to 3 re-prompts everybody anyway). Policy version 2 was prepared in the PR but never released, so there is no `v2.json`: the snapshots are v1 and v3.
End to end: `ConsentState`/`ConsentChoices.functional`, the registry (`cnote_recent_v1`), a third optional switch in the preferences dialog and on `/cookies` (rendered from `CATEGORIES`), `POST /api/consent` (`functional` optional, default false, for receipts queued by an older build), `cookie_consent_receipts.functional` (boolean, default false), identity purpose `functional_cookies` with account sync, the admin consent log (column, CSV column, grant counts), `requireConsent(req, "functional")`, and the cookie-audit e2e (a "preferences only" state).
