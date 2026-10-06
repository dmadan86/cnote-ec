import type { EventHandlers, ModuleWorker } from "@cnote/core";
import { purgeStorefront } from "./cache";
import { recheckEmbeds } from "./embeds";
import { storefrontSlugById, storefrontSlugForBusiness } from "./service";

/**
 * Cache invalidation for the buyer-facing storefront pages. A storefront embeds live platform data (verification tier,
 * trust score, listings, approved reviews), so events from other modules purge `storefront:<slug>` in both tiers
 * (Redis + the web ISR tag via POST /api/revalidate). Handlers are idempotent and never throw on a missing storefront.
 * Moderation-class events purge hard (never serve stale); ranking-class (trust score) purge soft.
 */
async function bySeller(businessId: string, hard: boolean): Promise<void> {
  const slug = await storefrontSlugForBusiness(businessId);
  if (slug) await purgeStorefront([slug], hard);
}
async function byStorefront(storefrontId: string): Promise<void> {
  const slug = await storefrontSlugById(storefrontId);
  if (slug) await purgeStorefront([slug], true);
}

export const storefrontHandlers: EventHandlers = {
  StorefrontPublished: async (e) => purgeStorefront([e.payload.slug], true),
  StorefrontVersionReviewed: async (e) => byStorefront(e.payload.storefrontId),
  StorefrontSuspended: async (e) => byStorefront(e.payload.storefrontId),
  TrustScoreChanged: async (e) => bySeller(e.payload.businessId, false),
  BusinessVerified: async (e) => bySeller(e.payload.businessId, false),
  ListingPublished: async (e) => bySeller(e.payload.sellerBusinessId, false),
  // Live-DB publisher (listing versions): storefront product grids read LIVE listings.
  ListingVersionPublished: async (e) => bySeller(e.payload.sellerBusinessId, false),
  ListingUnpublished: async (e) => bySeller(e.payload.sellerBusinessId, true),
  // Custom domain went active/inactive: the canonical URL (and JSON-LD @id) on every page changes.
  StorefrontDomainStatusChanged: async (e) => byStorefront(e.payload.storefrontId),
  // ai_ops: a video embed was approved / rejected / put back to pending
  StorefrontEmbedDecided: async (e) => byStorefront(e.payload.storefrontId),
  ListingModerated: async (e) => bySeller(e.payload.sellerBusinessId, true),
  ListingArchived: async (e) => bySeller(e.payload.sellerBusinessId, true),
  ListingImageModerated: async (e) => bySeller(e.payload.sellerBusinessId, true),
  ReviewModerated: async (e) => bySeller(e.payload.sellerBusinessId, true),
};

/** Register in apps/worker: `import { worker as storefrontWorker } from "@cnote/storefront"`. */
export const worker: ModuleWorker = {
  name: "storefront",
  handlers: storefrontHandlers,
  jobs: [
    {
      // Embed moderation: retry oEmbed fetches that failed, and re-check approved videos (title/description can change after approval).
      name: "storefront.embed-recheck",
      everyMs: 3_600_000,
      run: async () => {
        const r = await recheckEmbeds();
        if (r.retried || r.rechecked) console.log(`[storefront] embeds: retried ${r.retried}, re-checked ${r.rechecked}`);
      },
    },
  ],
};
