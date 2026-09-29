# ADR-034: Seller storefronts, Studio, custom domains and privacy-preserving analytics

**Status:** Accepted
**Note:** Designed with parallel work (`@cnote/storefront`, `@cnote/domains`, `apps/studio`).

**Context.** Sellers want a presence they own, on their own domain, which also raises retention, without us becoming a website builder for arbitrary HTML (XSS, phishing, SEO spam).

**Options.**
1. No storefronts. Marketplace pages only.
2. Free-form site builder with custom HTML.
3. Constrained, block-based storefronts from vetted templates, edited in a Studio app, moderated before publish, optionally served on a verified custom domain.

**Decision.** Option 3. `@cnote/storefront` stores a versioned JSON document (`StorefrontVersion`) built from typed sections and templates; no raw HTML. Studio (`apps/studio` :3004) edits drafts and previews. Publishing goes through moderation (ADR-033). `@cnote/domains` manages custom hostnames through an `EdgeProvider` (`EDGE_PROVIDER=cloudflare|vercel|aws|mock`): the seller adds a CNAME and TXT record, we verify DNS, request a certificate, track `StorefrontDomainStatus` and emit events; the web app resolves `Host` to a storefront in `proxy.ts`, and unknown hosts 404. Analytics are first-party and privacy-preserving: `StorefrontTrafficDaily` aggregates counts only, no cookies, no raw IPs, no cross-site identifiers; Clarity is not loaded on storefronts.

**Rationale.**
- Sellers get owned, branded presence with no HTML injection risk.
- Custom-domain plumbing is provider-neutral (ADR-036).
- Analytics need no consent banner because no personal data is collected.

**Consequences.**
- Certificate and DNS support burden; monitor stuck pending-validation domains.
- Template constraints will frustrate some sellers.
- AWS/Azure edge adapters are stubs or planned.

**Review.** Review after 20 live storefronts: template gaps, domain failure rate, and whether storefront traffic converts to enquiries.
