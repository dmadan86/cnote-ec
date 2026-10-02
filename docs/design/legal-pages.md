# Legal and information pages

DRAFT FOR COUNSEL REVIEW: all copy (`apps/web/messages/<locale>.legal.json`) is a working draft, not legal advice.

Pages (static, `app/[locale]/`, en + hi, `localizedAlternates`, in `LOCALIZED_PREFIXES` and the core sitemap): `/terms`, `/privacy`, `/refund-policy`, `/prohibited-items`, `/report`, `/about`, `/contact`, `/trust`, `/accessibility`, `/security`, `/sitemap`, plus `public/.well-known/security.txt` (RFC 9116).

## Structure
- Policy copy is data: `legal.<page>.sections[]` = `{ title, body[], items[] }`, rendered by `features/legal/legal-doc.tsx` (h1, version line, table of contents from 7 sections, one h2 per section). Inline links are `[[key]]` tokens resolved through `DOC_LINKS` in `features/legal/docs.ts`; `{site}`, `{email}`, `{grievanceEmail}` are substituted at render time.
- Versions and effective dates: `LEGAL_DOCS` in `docs.ts`. Bump on every copy change.
- Entity details: `features/legal/entity.ts` (env: `PLATFORM_LEGAL_NAME`, `PLATFORM_CIN`, `PLATFORM_GSTIN`, `PLATFORM_ADDRESS`, `SUPPORT_*`). Production should set all; the server logs an error at start when any is missing and refuses to start with `LEGAL_ENTITY_STRICT=true`.
- `/report` files a `@cnote/compliance` grievance ticket with the new category `report` (same queue, acknowledgement SLA and rate limit). The 24h acknowledgement and 36h takedown targets are operational promises in the copy; the ticket due date is still the grievance policy's resolution window.

## Sources
- ADR-002/003/005/010/013, `packages/compliance` RETENTION_POLICIES (privacy retention summary), `packages/ai` heuristic moderation classes (prohibited list), identity tiers T0-T3 (ADR-003).

## Research (Mobbin)
- [Supabase legal documents](https://mobbin.com/screens/f939e09b-60ab-4486-a2c8-9accad1ca0dd): one titled row per document with a short description; adopted for the sitemap and contact link cards.
- [DoorDash Merchant](https://mobbin.com/screens/d82a1987-db10-48ae-8607-3cf65786a1db): narrow single column, sectioned long-form text with plain headings; adopted for the reading width (`max-w-3xl`).
- [Magnific report content](https://mobbin.com/screens/527e75fb-7c1b-4430-bcc5-cb0cd55853b8) and [v0 flag a generation](https://mobbin.com/screens/069e6fb5-0014-43af-8f8a-f45d41b85d3d): reason selector plus free-text details; adopted for the type select and details field, extended with claimant, proof link and a good-faith declaration for IPR notices.

## Accessibility
Landmarks: one `main`, one "On this page" nav. Every control has a label; errors use `role="alert"` and `aria-describedby`; the declaration checkbox is 24px. Form fields are controlled so errors never erase input. axe e2e: `e2e/a11y/legal-pages.spec.ts`.
