// Cache tags + web-tier purge for storefronts (docs/design/performance-and-seo.md).
// Redis tier: cachedTagged in getPublishedStorefront. Web tier: Next ISR/data cache tag `storefront:<slug>`,
// purged through POST /api/revalidate (REVALIDATE_SECRET) — the same endpoint the search cache worker uses.
import { invalidateTags, softInvalidateTags } from "@cnote/core";

export const storefrontTag = (slug: string) => `storefront:${slug}`;

/** Canonical origin of the buyer site (no trailing slash). */
export const siteOrigin = () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");

interface WebTag {
  tag: string;
  hard?: boolean;
}

export async function purgeWeb(tags: WebTag[]): Promise<void> {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret || !tags.length) return;
  const url = process.env.WEB_REVALIDATE_URL ?? `${siteOrigin()}/api/revalidate`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) console.error(`[storefront] web revalidate ${res.status}`);
  } catch (err) {
    // ISR still expires by TTL; a transient outage must not poison the event stream.
    console.error("[storefront] web revalidate failed:", err instanceof Error ? err.message : err);
  }
}

/** Purge a storefront in both tiers. `hard` (moderation/suspension/publish) never serves stale; trust changes are soft. */
export async function purgeStorefront(slugs: string[], hard = true): Promise<void> {
  const list = [...new Set(slugs)].filter(Boolean);
  if (!list.length) return;
  const tags = list.map(storefrontTag);
  if (hard) await invalidateTags(tags);
  else await softInvalidateTags(tags);
  await purgeWeb(tags.map((tag) => ({ tag, hard })));
}

/**
 * Canonical URL of a storefront page. Returns the platform URL today. The domains module will make this return
 * the primary custom domain once one is active (hence async), so every caller (metadata, sitemap, JSON-LD) already awaits it.
 */
export async function getStorefrontCanonical(slug: string, pagePath = ""): Promise<string> {
  const rest = pagePath && pagePath !== "home" ? `/${pagePath.replace(/^\/+/, "")}` : "";
  return `${siteOrigin()}/store/${slug}${rest}`;
}
