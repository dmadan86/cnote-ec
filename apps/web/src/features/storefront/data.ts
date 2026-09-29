import "server-only";
import { unstable_cache } from "next/cache";
import { getPublishedStorefront, listLiveStorefrontSlugs, storefrontTag, type PublishedStorefront } from "@cnote/storefront";

/**
 * Public storefront read layer: Redis (inside getPublishedStorefront, tag `storefront:<slug>`) under the Next data
 * cache (same tag, purged by POST /api/revalidate from the storefront worker on publish / suspend / trust / listing /
 * review changes). Only live, moderated, non-suspended storefronts are ever returned or cached.
 */
export const loadStorefront = (slug: string): Promise<PublishedStorefront | null> =>
  unstable_cache(
    async () => {
      try {
        return await getPublishedStorefront(slug);
      } catch (err) {
        console.error("[web] storefront load failed:", err instanceof Error ? err.message : err);
        throw err; // never cache a failure; the page falls back to the error boundary
      }
    },
    ["web", "storefront", slug],
    { tags: [storefrontTag(slug)], revalidate: 300 },
  )();

/** Top live storefronts for generateStaticParams; empty when the DB is unavailable (build without services). */
export async function topStorefrontSlugs(limit = 50): Promise<string[]> {
  try {
    return (await listLiveStorefrontSlugs(limit)).map((s) => s.slug);
  } catch (err) {
    console.error("[web] listLiveStorefrontSlugs failed:", err instanceof Error ? err.message : err);
    return [];
  }
}
