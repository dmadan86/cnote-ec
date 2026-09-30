# Buyer site rail

**Scope (updated):** the rail is on every buyer web page, public and signed-in (home, search, categories, category/product pages, manufacturers, pricing, static pages, sign-in/up, compare, onboarding, grievance, not-found), under the existing sticky SiteHeader. It was first built for the signed-in dashboard only. Code: `apps/web/src/features/rail/`; mounted by `SiteFrame` (`site-frame.tsx`) from the three layouts that render the header: `app/[locale]/layout.tsx`, `app/(app)/layout.tsx` and the root fallback in `i18n/html-shell.tsx` (not-found, storefront routes). `(app)/(dashboard)/layout.tsx` now only adds the mobile `SectionStrip`.

## Static rendering (hard constraint)
Public pages stay static/ISR, so the rail never reads cookies or headers on the server.
- Server HTML is always the collapsed markup. State is CSS: the `rail-expanded:` Tailwind variant (`@custom-variant` in `globals.css`) matches `html[data-rail=expanded]`.
- `<html data-rail>` is set before first paint by a tiny inline script (`RAIL_SCRIPT` in `state.ts`, rendered in the root layout `<head>`) that copies the `cnote_rail` cookie. The toggle (`applyRailState`) writes both the cookie and the attribute; the rail observes the attribute (`useSyncExternalStore`) for `aria-expanded`. No hydration mismatch: the attribute lives on `<html suppressHydrationWarning>` and the markup is state-independent. If the script is blocked, a mount effect reads the cookie (a brief collapsed frame); no JS = collapsed.
- CSP: static/ISR pages allow inline scripts, so nothing changes there. Nonce-mode (dynamic) pages would block an un-nonced inline script, so `WEB_NONCE_SECURITY` (`csp.ts`) adds the script's sha256 to `script-src` for those responses only. (A hash in static mode would make browsers ignore `'unsafe-inline'` and block Next's own inline scripts, so it is deliberately not added there.)
- Items: signed-out visitors get public items (Home, Search, Categories, Manufacturers, Pricing; Request quote, Compare) and a Sign in entry at the bottom. Signed-in users (from `useUserState()`, i.e. `GET /api/me`) get the account groups instead of the last two, and "Your account". Until `/api/me` answers the item list is `invisible` (like the header's account cluster), so signed-in users never see a signed-out flash. Links go through `LocaleLink` (`/hi/search`; `/rfq/new`, `/signin`, `/compare` are unprefixed English routes). Active = longest prefix on the locale-stripped path; `/` matches only the home page.
- The item list scrolls inside the rail on short viewports; the account entry and toggle stay pinned. The header logo is not repeated in the rail.
- Layout: header, then `[rail | main + footer]`; the footer sits in the content column, so full-bleed sections (home hero, promo strip) span the column, not the rail. The container's 1600px cap centres within the column (responsive e2e updated).

## Original dashboard behaviour (still applies where not overridden above)

## Behaviour
- lg and up: 64px icon rail (white, `border-line`), icon groups split by short dividers, account/sign-in entry pinned at the bottom, then the expand toggle. Collapsed by default. The toggle expands it to 240px (icon + label) and back; the width animates 200ms, disabled under `prefers-reduced-motion`.
- State lives in the `cnote_rail=expanded|collapsed` cookie (path=/, 1 year, Lax), applied to `<html data-rail>` before first paint (see above).
- Sticky under the site header. The header is one row at 2xl and two rows from lg to 2xl, so `HeaderHeightVar` publishes its measured height as `--site-header-h` (ResizeObserver, CSS fallback 6.5rem).
- Below lg: no rail; a horizontally scrollable section strip (icon + label, 44px targets, `aria-current`, an underline bar as the non-colour cue) opens the content column.
- Items are in one typed file (`items.ts`), active = longest segment-wise prefix of the pathname. Not listed because no index page exists: Disputes (`/buyer/disputes/[id]` only) and Conversations (`/conversations/[id]` only). "Export my data" is a file route handler, so it is a plain `<a download>`.

## Accessibility
`<nav aria-label="Site navigation">` (header's is "Primary"; the strip is "Account sections"). Collapsed links keep their name as `sr-only` text; the tooltip is `aria-hidden` and supplementary: shown on hover and focus, hoverable (8px padded bridge), persistent, dismissed by Escape from anywhere (document listener), placed to the right so it never covers the item. Toggle is a `button` with `aria-expanded`, `aria-controls="buyer-rail"` and a name that flips between "Expand sidebar" and "Collapse sidebar". Active item: brand-50 fill, semibold, left indicator bar. Tooltips use `position: fixed` so the rail can scroll on short viewports without clipping them.

## Research (Mobbin; web screens)
- Supabase project dashboard (https://mobbin.com/screens/d0bed8cf-717c-4148-9e24-2f7d9c8e79a1): icon-only rail with grouped icons and a settings item pinned at the bottom. Adopted: rail width, grouping, bottom pin.
- Perplexity (https://mobbin.com/screens/2891d073-cefe-4429-8ab2-5f464e860171): a panel-toggle icon at the top of a labelled sidebar collapses it. Adopted: panel icon pair for the toggle (we put it at the bottom, as the owner asked).
- Calendly (https://mobbin.com/screens/5ba2bfae-cea9-4fbe-b9b6-b05b8bcd1510) and Tana (https://mobbin.com/screens/36071167-cb50-4ddf-b34c-f6d0b2037da9): the soft filled rounded square for the active item, and the profile/settings entries at the bottom of the expanded sidebar. Adopted: active style, expanded layout.
- The Mobbin search returned no screenshot of a hover tooltip on a collapsed rail, so tooltip behaviour follows WCAG 1.4.13 rather than a reference.
