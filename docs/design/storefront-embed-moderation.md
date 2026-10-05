# Storefront embed moderation

Status: built, flag still off. `STOREFRONT_EMBEDS_ENABLED` default is unchanged and `CONSENT_POLICY_VERSION` is not bumped. Relates to ADR-003, ADR-008, ADR-041 and `docs/design/cookie-consent.md`.

## What exists

- **Providers (allowlist):** YouTube (always `youtube-nocookie.com`), Vimeo (`player.vimeo.com`, `dnt=1`; public videos only, unlisted hash links are refused) and OpenStreetMap maps. The seller supplies an id or coordinates, never a URL or HTML. `EMBED_FRAME_ORIGINS` and the web CSP `frame-src` gained `https://player.vimeo.com`.
- **Moderation (`packages/storefront/src/embeds.ts`):** at publish, each distinct YouTube/Vimeo video gets a `StorefrontEmbedReview` row. The platform fetches the public oEmbed metadata server-side (`assertPublicHttpTarget` + `pinnedFetch`, fixed provider hosts built from the validated id, no redirects, 8 s timeout), then screens title, channel, description and the thumbnail reference as one text through `ai.moderate` (deterministic prohibited-content pre-check first; the model can escalate, never relax). Maps carry only the block title, which is already part of the publish text screen.
- **Hold until approved:** the renderer shows a video only when its key (`youtube:<id>`) is in `RenderData.approvedEmbeds`; absent means hidden (fail closed). In Studio's preview the seller sees "waiting for approval". Publishing is not blocked by a held video; `PublishOutcome.heldEmbeds` reports the count.
- **Auto-approval = listing strictness:** `catalogue.mayAutoApprove` (deterministic-clean AND model allow AND tier >= 1 AND trust >= 60 AND account age AND staff-approved history, same `LISTING_AUTO_APPROVE_*` env). Staff-approved history counts staff-approved storefront versions and embeds. A thumbnail that does not come from the provider's image host, a failed fetch, or unavailable screening always means pending. A `LISTING_AUTO_APPROVE_SAMPLE_RATE` share of would-be auto-approvals is held for staff instead (stricter than the listing post-publication audit; nothing needs undoing).
- **Ops queue:** admin `Storefront embeds` (`/storefronts/embeds`, privilege `storefronts.review`, every decision through `audited()`); a rejection needs a note the seller sees. `block` verdicts reject outright.
- **Re-check:** worker job `storefront.embed-recheck` (hourly tick) retries failed fetches and re-checks approved videos every `STOREFRONT_EMBED_RECHECK_DAYS` (7). A new `block` rejects, a new `review` hides until staff look, a removed/private video (404/403) hides, a provider outage does not.
- **Events:** `StorefrontEmbedDecided` v1; the storefront worker purges the page cache on it.
- **Data:** table `storefront_embed_reviews` (provider's public metadata only; no visitor or seller personal data).

## Decisions

- Thumbnail: `ai.moderate` is text-only and no image-moderation capability exists, so the thumbnail contributes its provider file reference to the text and must come from the provider's image host. Pixel-level moderation is not done; the human review step and the open-link-to-judge workflow cover it.
- Moderation is per video, not per storefront version, so a seller can swap the video without re-reviewing the whole page, and a decision survives republishing.
- Vimeo is shipped in code now but is inert while the flag is off.

## What remains to turn the flag on

1. **Consent notice names Vimeo.** `consent.embedsNote` (`apps/web/messages/en.json` and `hi.json`) lists "YouTube, OpenStreetMap". Add Vimeo. Because `policy-snapshots/v4.json` is the committed flag-on snapshot, this is a notice change that needs a new policy version and snapshot (v5); the lead decides, as it re-asks every visitor.
2. Counsel review before enabling (ADR-041 review item).
3. Run an ops dry period: turn the flag on in staging, confirm the queue volume and the false-positive rate of auto-approval.
4. Rebuild the web app (the flag is inlined at build time) and set `STOREFRONT_EMBEDS_ENABLED=1`.
5. Optional follow-ups: an image-moderation capability for thumbnails; seller-facing status (Studio shows state via `embedStatusesForSeller`, no UI yet); an ops view of embed volume in metrics.
