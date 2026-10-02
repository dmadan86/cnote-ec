# Help centre, nav cleanup and PWA (buyer web)

Scope: `apps/web`. Related: ADR-002 (lead cap, cascade, refund), ADR-003 (verification tiers), ADR-004 (language, voice,
low bandwidth), ADR-005 (public pricing), ADR-007 (off-platform "did this close?" prompt), ADR-010 (DPDP).

## Help centre (`/help`)

Static, localised (en, hi) under `app/[locale]/help/`, listed in `LOCALIZED_PREFIXES` and in the core sitemap segment
(landing, six topic pages, 16 articles, each with hreflang alternates).

| Route | Content |
| --- | --- |
| `/help` | Search box, six topic cards, popular articles, "still need help" (grievance, report) |
| `/help/[topic]` | Topic header and its article list |
| `/help/[topic]/[article]` | Two sections, links, one FAQ, related articles; breadcrumbs plus `FAQPage` and `BreadcrumbList` JSON-LD |

All three use `generateStaticParams` over `LOCALES` and `dynamicParams = false`.

**Content.** `features/help/articles.ts` is a typed manifest (ids, topics, related ids, popular order, link keys). Every word
is a message key in `messages/<locale>.help.json` (`help.topic.<id>`, `help.a.<id>.{title,summary,h1,p1,h2,p2,q,ans}`,
`help.link.*`), registered in `i18n/messages.ts`. A test (`test/help-nav.test.tsx`) checks every article has every key in all
eight catalogues, and that the guarantees in the copy (at most 3 suppliers, 2 hours, 72 hours, 90 days, no renewal without
confirmation) are still stated. When an ADR rule changes, change the copy and that test together.

**Search.** `features/help/help-search.tsx` filters titles and summaries on the client (whole index is a few KB, no request,
works on slow links). Only the five strings it needs reach the browser, through a nested `NextIntlClientProvider`, so the
article catalogue stays out of the client payload. The result count is announced through a polite `role="status"` region.

**Topics.** Buying and requirements; Suppliers and verification; Leads and credits for sellers; Payments and refunds;
Account and privacy; Safety and reporting. Report links point at `/report` and `/grievance` (built by other work; both
are unlocalised routes).

### Mobbin references adopted

Searched Mobbin (web screens, "help centre landing page with search and topic cards") and adopted:

- **Intercom and Navan help centres:** a centred "How can we help?" heading with one prominent rounded search field above
  a card grid of topics, each card with a title, one-line description and article count.
- **n8n:** a flat list of questions below the cards as the FAQ pattern (here one question per article, which is what
  produces the `FAQPage` markup).
- **GetYourGuide and Revolut:** a single narrow reading column for article pages and large full-width tap rows for lists
  (44px-class targets on mobile).
- **Zendesk and Amazon:** a visible "Popular" list under the topics and a "still need help" block at the bottom.

Not adopted: hero illustrations and gradient banners (low bandwidth, ADR-004), chat widgets (no live support in Phase 1).

## Navigation cleanup

- `features/shell/site.ts`: `NavGroup.href` makes a group a plain link; `visibleNav()` drops every `soon: true` item and any
  dropdown left empty. The header (`nav-menus.tsx`) and the mobile menu both render `visibleNav()`. Templates & Design and
  Business Services disappear; AI Tools keeps AI Search; Resources becomes **Help** linking to `/help`.
- The `/coming-soon/*` routes are untouched, so direct links still work.
- The buyer rail has no coming-soon items, so it needed no change.
- **Home AI-design promo (`promo-panels.tsx`):** kept, clearly badged "Coming soon", with the fake "Try AI Design" button
  removed (no CTA). We chose this over pointing it at `/rfq/new` because the card's copy promises design generation, and
  re-pointing it would need new copy in eight catalogues for something the product does not do yet.

## PWA (ADR-004)

- `app/manifest.ts` (`/manifest.webmanifest`): name, short name, `standalone`, `start_url: /`, theme `#6d3ff0`
  (brand-600) and background `#f8f9fc` (canvas) from the design tokens. Icons are generated PNGs from the brand mark
  (`app/icons/[name]/route.tsx`, prerendered, same technique as the Open Graph card): 192, 512, maskable 512 and the
  180px Apple touch icon.
- `public/sw.js`, registered by `features/pwa/sw-register.tsx` in production only. Rules (typed source of truth in
  `features/pwa/sw-rules.ts`, copied into the worker; `test/pwa-sw.test.ts` runs the real script in a sandbox and asserts both
  agree):
  - only same-origin GETs are handled, never POSTs, server actions, Range or cross-origin requests;
  - `/api`, sign-in/up, account, buyer, rfq, wishlist, compare, grievance and the other private prefixes are never intercepted;
  - `/_next/static` and images: cache first (images capped at 80 entries);
  - navigations: network first; offline, the last good copy (help pages only) else `/offline` or `/hi/offline`,
    precached at install together with the static assets they reference.
- The CSP already allowed `worker-src 'self' blob:` and `manifest-src 'self'` (`@cnote/security`); a test now pins that.
- `/sw.js` is served `no-cache` so a new worker is picked up promptly.
- The worker stores no personal data and uses Cache Storage, not cookies or localStorage, so it needs no consent-registry
  entry.

## e2e

`e2e/a11y/help.spec.ts`: axe on `/help` and one article in en and hi, search filtering, FAQ and breadcrumb JSON-LD, Help nav
link and no coming-soon entries, manifest (200, JSON, icons resolve), service worker headers and both offline pages.
