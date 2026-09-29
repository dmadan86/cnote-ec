import { cacheTags, invalidateTags, softInvalidateTags, type EventHandlers, type ModuleWorker } from "@cnote/core";

/**
 * Cache invalidation worker (performance layer). Maps domain events to cache tags and purges BOTH tiers:
 *   1. Redis tagged entries (@cnote/core cachedTagged / cachedManyTagged): hard for anything moderation-related
 *      (a rejected/archived listing or review must disappear immediately), soft (stale-while-revalidate) for ranking data.
 *   2. The web app's Next.js data/ISR cache, through POST {WEB_REVALIDATE_URL|APP_URL/api/revalidate} authenticated with
 *      REVALIDATE_SECRET (Bearer). Skipped silently when no secret is configured (dev).
 * Module write paths already invalidate Redis after commit; this worker is the durable, cross-process, at-least-once
 * backstop and the only thing that reaches the web tier. Every handler is idempotent.
 */

interface WebTag {
  tag: string;
  /** hard = blocking revalidate (never serve stale); default soft = stale-while-revalidate. */
  hard?: boolean;
}

async function purgeWeb(tags: WebTag[]): Promise<void> {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret || !tags.length) return;
  const url = process.env.WEB_REVALIDATE_URL ?? `${process.env.APP_URL ?? "http://localhost:3000"}/api/revalidate`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) console.error(`[cache-worker] web revalidate ${res.status}`);
  } catch (err) {
    // The web tier still expires by TTL; do not poison the event stream over a transient outage.
    console.error("[cache-worker] web revalidate failed:", err instanceof Error ? err.message : err);
  }
}

async function listingChanged(listingId: string, sellerBusinessId: string, hard: boolean) {
  const hardTags = [cacheTags.listing(listingId), cacheTags.sellerListings(sellerBusinessId), cacheTags.sitemap];
  if (hard) await invalidateTags(hardTags);
  await softInvalidateTags([cacheTags.featured, cacheTags.search]);
  await purgeWeb([
    { tag: cacheTags.listing(listingId), hard },
    { tag: cacheTags.sellerListings(sellerBusinessId), hard },
    // Rails and result pages embed the listing, so a moderation/archive event must purge them hard too
    // (blocking revalidate) or one more request could still see the withdrawn listing.
    { tag: cacheTags.featured, hard },
    { tag: cacheTags.search, hard },
    { tag: cacheTags.sitemap },
  ]);
}

async function reviewsChanged(listingId: string) {
  await invalidateTags([cacheTags.rating(listingId), cacheTags.reviews(listingId)]);
  await purgeWeb([{ tag: cacheTags.reviews(listingId), hard: true }, { tag: cacheTags.rating(listingId), hard: true }]);
}

async function sellerChanged(businessId: string) {
  await invalidateTags([cacheTags.seller(businessId), cacheTags.sellers, cacheTags.sitemap]);
  await purgeWeb([{ tag: cacheTags.seller(businessId) }, { tag: cacheTags.sellers }, { tag: cacheTags.sitemap }]);
}

export const cacheHandlers: EventHandlers = {
  ListingPublished: async (e) => listingChanged(e.payload.listingId, e.payload.sellerBusinessId, false),
  ListingModerated: async (e) => listingChanged(e.payload.listingId, e.payload.sellerBusinessId, true),
  ListingArchived: async (e) => listingChanged(e.payload.listingId, e.payload.sellerBusinessId, true),
  ListingImageModerated: async (e) => listingChanged(e.payload.listingId, e.payload.sellerBusinessId, true),
  ReviewModerated: async (e) => reviewsChanged(e.payload.listingId),
  CommentModerated: async (e) => reviewsChanged(e.payload.listingId),
  TrustScoreChanged: async (e) => sellerChanged(e.payload.businessId),
  BusinessVerified: async (e) => sellerChanged(e.payload.businessId),
  BusinessCreated: async (e) => (e.payload.isSeller ? sellerChanged(e.payload.businessId) : undefined),
  DataErasureRequested: async () => {
    await invalidateTags([cacheTags.reviewsAll]);
    await purgeWeb([{ tag: cacheTags.reviewsAll, hard: true }]);
  },
};

/** Register in apps/worker alongside the other module workers: `import { cacheWorker } from "@cnote/search"`. */
export const cacheWorker: ModuleWorker = { name: "cache", handlers: cacheHandlers, jobs: [] };
