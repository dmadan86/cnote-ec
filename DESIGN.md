# DESIGN.md

UI/UX system for the marketplace. The visual target is `docs/design/home-reference.png`, and the product rules come from `docs/adr/ADR-v0.1.md`. Tokens and primitives live in `packages/ui`. Change them there, never with one-off hex values in apps.

## Principles

1. **Trust made visible.** Every seller surface shows the *real* verification tier and trust signals (ADR-003). Buyers see why a seller is shown; sellers see the intent score, their rank and the N cap on every lead (ADR-002).
2. **Never pay-to-look-better.** Plan or payment never changes a badge, colour or rank. Sponsored slots, when they exist, carry a visible "Sponsored" label (ADR-009).
3. **Bharat-first.** Design for mobile, low bandwidth and vernacular or Hinglish users first. Desktop is the enhancement.
4. **Transparent money.** Show prices as ₹ per unit together with the MOQ. Plans are public, with no hidden costs and no dark patterns around renewal or cancellation (ADR-005).
5. **AI is assistive and labelled.** AI drafts are editable, and each one is marked as an AI draft until the user confirms it. The AI never commits a user to anything.

## Tokens (`packages/ui/src/styles.css`)

| Token | Value | Use |
|---|---|---|
| `brand-600` / `700` | `#6d3ff0` / `#5b2fd6` | Primary actions, links, active tabs, "Join for Free" |
| `brand-50` / `100` | tints | Hero wash, selected chips, info surfaces |
| `accent-500` / `600` | `#f97316` / `#ea580c` | Decorative accent only (icons, bars, stars). Below AA for text on white |
| `accent-700` / `800` | `#c2410c` / `#9a3412` | **Quote/RFQ CTAs** ("Request Quote", white text 5.2:1) and accent text |
| `accent-50` | tint | Quote promo panel background |
| `ink` / `muted` | `#111827` / `#596272` | Body text / secondary text |
| `line` | `#e5e7eb` | Borders, dividers |
| `canvas` / `surface` | `#f8f9fc` / `#fff` | Page background / cards |
| `success` `warning` `danger` | `#15803d` / `#b45309` / `#b91c1c` (AA text on white and on their -50 tints) | Status, intent score bands, errors |
| `radius-card` | `0.875rem` | Cards, panels, product tiles |

- **Buttons** are pill-shaped (`rounded-full`). **Inputs** use `rounded-lg`.
- **Type:** Geist Sans.
  - Hero H1: 48–56px/800, with the last line in `brand-600` ("in One Place").
  - Section titles: 20–22px/700.
  - Body text: 14–16px.
- **Spacing:** 4px grid. Sections are separated by 40–56px vertically.
- **Page width:** `Container` is 1280px max, with 16/24/32px gutters.

## Primitives (`@cnote/ui`)

The following are exported from `@cnote/ui`: `Button` / `buttonClasses`, `Card*`, `Input`, `Textarea`, `Select`, `Field`, `Badge`, `TrustBadge`, `IntentScore`, `Money`, `Container`, `PageHeader`, `EmptyState`, `Alert`, `Stat` and `cn`.

- Use `buttonClasses()` on a Next `<Link>` for link-buttons.
- Put a component in `packages/ui` when two or more features need it. Feature-only components live in `apps/web/src/features/<module>/`.
- Variant rules:
  - `primary`: one per view for the main action.
  - `accent`: RFQ/quote actions only.
  - `outline`: secondary actions.
  - `ghost`: toolbar and menu actions.

## Domain components and their rules

- **TrustBadge.** Its label comes from the verification tier:
  - T1: "GST verified"
  - T2: "KYC verified"
  - T3: "Audited"
  - Below T1, or when the badge has been revoked for a low trust score: "Unverified" (neutral).

  Never show "Verified" based on plan.
- **IntentScore.** Bands: ≥70 green, 40–69 amber, <40 red. Always show it next to its reasons (the list from `intentReasons`) on lead cards.
- **Lead card (seller).**
  - Shows the title, quantity + unit, delivery city, needed-by date, IntentScore, "Rank r of N", and a countdown to `respondBy` (2h). Accept is `primary`; Decline is `outline`.
  - Before acceptance, the buyer's name and phone stay hidden. After acceptance, show the buyer's contact, the conversation and the "Report unreachable/fake" link (72h auto-refund).
- **Product card.**
  - Square image area on a `canvas` background, with a wishlist heart top-right.
  - Title (2 lines max), `Money` (₹ / unit), then "Min. order: 500 pcs" in `muted` text.
  - Show the seller's TrustBadge on search results.
- **Money.** Stored as integer paise and rendered with Indian digit grouping: ₹1,00,000, ₹5.20. Always pair it with a unit.

## Home page anatomy (matches the reference)

1. **Header.** Logo; mega-menus (Products, Manufacturers, Templates & Design, AI Tools, Business Services, Resources); a "Deliver to India" pincode picker; the Request Quote, Orders and Sign in links; and the `primary` "Join for Free" button. On mobile, this collapses to the logo, a search icon and a menu sheet.
2. **Hero.**
   - Left column: H1, subcopy, and four trust ticks (Verified suppliers · Best prices · Bulk orders · Pan India delivery).
   - Centre: a search card with tabs (AI Search · Products · Manufacturers · Templates · Business Services), a large input, the `primary` Search button, and "Try asking" example chips.
   - Right column: three floating value cards over the warehouse image (Find verified manufacturers / Create custom designs with AI / Source at best prices).
3. **Shop by Category.** A horizontal grid of 12 tiles (icon or image plus a 2-line name), ending with "More Categories". On mobile it becomes a horizontal scroll.
4. **Three promo panels.**
   - Design with AI (brand tint).
   - Get Quotes from Verified Suppliers (accent tint, listing three suppliers with a verified tick and the city, plus an `accent` "Request Quote" button).
   - Connect with Manufacturers (brand tint, India map with pins).
5. **Popular Products.** Tabs (For Your Business / Trending / New Arrivals / Best Selling) above a rail of eight product cards, with "View all products →" on the right.

"Templates & Design" and "AI Design" come from the reference but are **not in the ADRs**. Render them as clearly labelled "Coming soon" entry points until an ADR covers them.

## Content and language

- The UI copy is plain English for now. Write every string so it can be extracted later: no string concatenation for sentences, and leave room for 30–40% longer Indic text.
- Search accepts mixed-script and transliterated input ("kraft box 3 ply", "गत्ते का डिब्बा").
- Use numbers and units as sellers speak them: pcs, kg, meter, set, ton.

## States and feedback

- Every list has an `EmptyState` with the next action ("Post your first listing", "Post a requirement").
- Loading uses skeletons for rails and grids, not spinners.
- Errors are shown inline with the field (`Field error`), and page-level problems use `Alert tone="danger"`. Never show raw error codes.
- AI actions show "Drafting…" progress and the result as an editable form, never an auto-submit.

## Accessibility and performance

**WCAG 2.2 AA is mandatory for the buyer web (`apps/web`), not a nice-to-have.** A web change that regresses accessibility does not ship. Automated checks (jsx-a11y lint, axe-core scans in CI) catch the basics, and a keyboard-plus-screen-reader walkthrough of new buyer flows catches the rest. The seller and admin apps follow the same components but aren't gated.


- WCAG AA contrast. Text on `brand-600` and `accent-700` is white; `accent-500` is decorative only and never carries text.
- All interactive elements are reachable by keyboard with visible `focus-visible` outlines. Icons get `aria-hidden` and buttons get text labels.
- Target 44px touch areas on mobile.
- Pages must be usable on 3G:
  - Images are lazy-loaded via `next/image` with explicit sizes.
  - Nothing above the fold waits on client JS; prefer Server Components.
  - Client components only for interactivity.

## Imagery

Dummy seed products use generated placeholder illustrations (SVG or data from `public/placeholders/`). Real product photos will replace them. Never hotlink third-party images.
