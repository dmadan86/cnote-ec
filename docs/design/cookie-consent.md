# Cookie consent manager (buyer web)

Status: implemented in `apps/web/src/features/consent`. Owner: buyer web + `@cnote/compliance` (receipts).
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
| **Global Privacy Control** (CCPA/CPRA regs 11 CCR 7025) | `navigator.globalPrivacyControl === true` or `Sec-GPC: 1` treats marketing as opted out: "Accept all" grants analytics only; the user can still switch marketing on explicitly. Recorded in the receipt. |
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

### Cookie / storage classification

| Key | Kind | Category | Provider | Duration |
|---|---|---|---|---|
| `cnote_consent` | cookie | necessary | first party | 12 months |
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

## Single source of truth

`features/consent/registry.ts` lists every key with category, provider, purpose message key and duration. The preferences
dialog, the cookie policy page (`/cookies`, static, en + hi) and the withdrawal cleanup all read it.
`test/consent-registry.test.ts` fails when code under `apps/web/src` mentions a quoted `cnote_*` key that is not in the
registry, and checks the shared-package cookies (auth, OAuth/MFA challenge, compare tray) are listed.

## Consent record (cookie)

`cnote_consent` = URL-encoded `v=1&id=<32 hex>&a=1&m=0&t=<unix s>&gpc=0`, first party, `Path=/`, `SameSite=Lax`, `Secure` on
https, **not** httpOnly (client islands read it), `Max-Age` = 12 months. Pure `parseConsent`/`serializeConsent`
(`features/consent/state.ts`) are shared by client and server. A missing, malformed, expired (over 12 months), future-dated
or older-`CONSENT_POLICY_VERSION` value, and the legacy `granted`/`denied` values, all mean "no choice": ask again.

`cnote:consent` (window event, `detail` = the state) fires on every change so islands react without a reload; Clarity, the
manager and the leadgen helpers listen or re-read the cookie.

## Gating

- Clarity loads only with `analytics` granted; `consentv2.ad_Storage` follows `marketing`. On withdrawal Clarity is told
  `denied`, `_clck`/`_clsk` are expired on the host and every parent domain, and the script is not loaded again.
- Client: `getVisitorId()`, `captureAttribution()` and the nudge store write nothing unless `marketing` is granted; without it
  the visitor id is in memory and the nudge caps live in memory for that page load (features keep working, they just do not
  remember). Without marketing consent no UTM/referrer is collected.
- Server: `/ad/[token]`, `/api/ads/similar`, `loadSponsoredForResults` and `attributeEnquiryFromCookie` read `cnote_consent`
  from the request; without `marketing` they neither set nor read `cnote_vid`/`cnote_ad_click` (the click is still recorded and
  the redirect still works).
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
| `analytics`, `marketing` | per-category choice (necessary is always on and needs no consent) |
| `gpc` | Global Privacy Control was on (cookie flag OR `Sec-GPC: 1`) |
| `action` | `accept_all` / `reject_all` / `custom` / `withdraw` (any switch-off of something granted is `withdraw`) |
| `locale` | language the notice was shown in |
| `person_id` | only when signed in (existing session helper); nullable, no FK (module boundary) |
| `created_at` | server time (authoritative) |

**No IP address and no user agent are stored** (data minimisation); the IP is only the rate-limit key. Rows are append-only.
Validation is strict (zod, unknown keys rejected, action consistent with the choices).

**Retention: 3 years** (`compliance.cookie_consent_receipts`, env `RETENTION_COOKIE_CONSENT_RECEIPTS_DAYS`). The receipt must
outlive the consent it evidences so we can meet the s.6(10) burden of proof; 3 years matches the general limitation period
(Limitation Act 1963, art. 113) in which a dispute could be raised, and s.8(7) forbids keeping it longer. Pending counsel
review, like the other retention windows. Erasure requests: the receipt carries no direct identifiers, and where a
`person_id` is present it is retained as proof of compliance with law (s.8(7) exception); counsel to confirm.

## Adding a cookie or storage key

1. Add the entry to `STORAGE_REGISTRY` (`registry.ts`): name exactly as written by code, category, kind, provider, purpose
   key, duration (and `httpOnly` / `alsoServerSet` if the server writes it).
2. Add `consent.purpose.<key>` (and any new duration/provider key) to **all 8** `apps/web/messages/*.json` catalogues.
3. Non-essential keys must call `clientGranted("analytics" | "marketing")` (client) or read `cnote_consent` from the request
   (server) before writing. Strictly necessary keys need a one-line justification in the registry comment.
4. **Bump `CONSENT_POLICY_VERSION` and `CONSENT_POLICY_UPDATED` (`state.ts`) when a NEW non-essential purpose or provider is
   added**, or an existing one changes materially: everybody is asked again. Adding a strictly necessary key, or renaming a
   purpose string, does not need a bump.
5. `pnpm --filter @cnote/web test` (registry completeness) must pass.

## Judgment calls

- The banner is rendered right after the skip link (before the header), so keyboard and screen-reader users meet the
  notice first while "Skip to content" stays the first Tab stop (WCAG 2.4.1). It is a region, not a dialog, and never
  steals focus; visually it is fixed to the bottom of the viewport.
- The Analytics category is always listed, even when `NEXT_PUBLIC_CLARITY_PROJECT_ID` is unset, so the notice, the policy
  page and the receipt do not change with configuration.
- `cnote_vid` is now 30 days on the client as well (it was 1 year), matching the server-set cookie.
- A receipt that fails to save does not block the choice; the cookie is authoritative for behaviour and the write is retried
  only by the user's next choice. Failed writes are logged (`[web] /api/consent failed`).
- The other six catalogues (kn ta te mr gu bn) are machine-drafted like the rest of those catalogues and need native review.
