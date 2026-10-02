# Buyer web footer

Rendered on every buyer web page (`apps/web/src/features/shell/site-footer.tsx`) inside the site frame, next to the rail.

## Research (Mobbin)

- [Codecademy](https://mobbin.com/screens/28de8090-c391-4a77-91a0-d77416112fce) and [Shop](https://mobbin.com/screens/ec6b4513-a008-4090-8d31-36879aa1bd82): brand and mission on the left, balanced link columns on the right, a thin legal bar.
- [GetYourGuide](https://mobbin.com/screens/40271de8-034a-4bec-ab1b-f0faa9274414) and [lululemon](https://mobbin.com/screens/33701ff5-9edf-48b1-a10b-6fd40c592a23): dark full-bleed footer; "privacy choices" sits with the legal links; language picker in the footer.
- [Fiverr](https://mobbin.com/screens/6d920099-9b0a-4b8e-9377-632dfb849f0f) and [Amazon](https://mobbin.com/screens/ce480d77-843c-44cb-a701-8ef0782322cc): a closing prompt above the links for visitors who scrolled to the end.

## Anatomy

1. **Closing call to action**: "Can't find what you need?" with Post a requirement (accent, the buyer's main job) and Sell on (outline).
2. **Brand block**: logo, mission line, three trust promises that mirror the ADRs: real verification tier (ADR-003), at most 3 suppliers per requirement (ADR-002), public pricing with no auto-renewal (ADR-005).
3. **Links**: one `nav` landmark ("Footer") with four headed lists: Buy, Sell, Company (About, Contact, Help, Trust & Safety, Sitemap) and Legal (Terms, Privacy, Cookie policy, Refund policy, Prohibited items, Dispute policy, How ranking & ads work, Grievance redressal, Report abuse, Accessibility, Security, plus the Cookie settings button, so withdrawal is as easy as consent). 2 columns on phones, 4 from `sm`. The four `/coming-soon` links were removed; those pages stay reachable from the header menus. New link labels live in the `legal` message namespace (`messages/<locale>.legal.json`, `legal.footer.*`).
4. **Bottom bar**: legal entity line (legal name, CIN, GSTIN, registered office, from env via `features/legal/entity.ts`; dev shows `[... not configured]` placeholders), then the copyright and data notice, a small `llms.txt` link and the language switcher.

## Accessibility

On `brand-900`: white text is 14:1, `brand-200` links 10:1, `brand-100` body 12:1. Focus rings are white. Links are at least 32px tall (24px in the bottom bar) and buttons 44px. There is one footer landmark and one footer nav, with column titles as `h2`.
