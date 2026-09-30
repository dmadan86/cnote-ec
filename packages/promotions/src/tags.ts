import { cacheTags, invalidateTags, softInvalidateTags } from "@cnote/core";

/** Cache tags owned by this module. Offer reads also carry the listing's own tag, so catalogue events purge them too. */
export const promoTags = {
  all: "promotions",
  surface: (s: string) => `promotions:${s}`,
  offers: "offers",
  offer: (listingId: string) => `offer:${listingId}`,
} as const;

interface WebTag {
  tag: string;
  hard?: boolean;
}

/** Purges the web tier's ISR/data cache (same endpoint the search cache worker uses). Silent when no secret is configured (dev/CI). */
export async function purgeWeb(tags: WebTag[]): Promise<void> {
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
    if (!res.ok) console.error(`[promotions] web revalidate ${res.status}`);
  } catch (err) {
    console.error("[promotions] web revalidate failed:", err instanceof Error ? err.message : err);
  }
}

/** A pulled or approved promotion must take effect at once: hard purge (never serve a pulled banner stale). */
export async function bustPromotions(surfaces: string[]): Promise<void> {
  const tags = [promoTags.all, ...surfaces.map(promoTags.surface)];
  await invalidateTags(tags).catch(() => {});
  await purgeWeb(tags.map((tag) => ({ tag, hard: true })));
}

export async function bustOffers(listingIds: string[]): Promise<void> {
  const ids = [...new Set(listingIds)];
  const hard = [...ids.map(promoTags.offer), ...ids.map(cacheTags.listing)];
  // an ended offer must vanish immediately (hard); the listing tag is soft so the PDP rebuilds in the background
  await invalidateTags(ids.map(promoTags.offer)).catch(() => {});
  await softInvalidateTags([promoTags.offers]).catch(() => {});
  await purgeWeb([...hard.map((tag) => ({ tag, hard: tag.startsWith("offer:") })), { tag: promoTags.offers }]);
}
