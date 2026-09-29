import { createHash } from "node:crypto";
import * as ai from "@cnote/ai";
import { getCategoryBySlug, getListingsByIds, retrieveListings } from "@cnote/catalogue";
import { cached } from "@cnote/core";
import { getTrustProfiles } from "@cnote/identity";
import { z } from "zod";
import { locationBoost, rrfFuse, trustFactor } from "./fusion";
import { normaliseQuery } from "./normalise";
import type { SearchHit } from "./index";

const optsSchema = z.object({
  q: z.string().max(500),
  categorySlug: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

export async function searchListings(opts: { q: string; categorySlug?: string; limit?: number }): Promise<{ hits: SearchHit[]; tookMs: number }> {
  const started = Date.now();
  const { q, categorySlug, limit } = optsSchema.parse(opts);
  const nq = normaliseQuery(q);
  const key = `search:q:v1:${createHash("sha1").update(JSON.stringify([nq, categorySlug ?? null, limit])).digest("hex")}`;
  // 60s cache of identical queries; tookMs always reflects this call.
  const hits = await cached(key, 60, () => run(nq, categorySlug, limit));
  return { hits, tookMs: Date.now() - started };
}

async function run(nq: ReturnType<typeof normaliseQuery>, categorySlug: string | undefined, limit: number): Promise<SearchHit[]> {
  let categoryId: string | null = null;
  let categoryName = "";
  if (categorySlug) {
    const cat = await getCategoryBySlug(categorySlug);
    if (!cat) return [];
    categoryId = cat.id;
    categoryName = cat.name;
  }
  const text = nq.text || categoryName; // pure category browse falls back to the category's own text
  if (!text) return [];

  let embedding: number[] | undefined;
  try {
    embedding = (await ai.embed([text])).vectors[0];
  } catch {
    embedding = undefined; // embedding outage degrades to lexical-only rather than failing search
  }
  const cands = await retrieveListings({ text, embedding, categoryId, limit: Math.max(30, limit * 3) });
  if (!cands.length) return [];

  const fused = rrfFuse(cands);
  const profiles = await getTrustProfiles([...new Set(cands.map((c) => c.sellerBusinessId))]);
  const scored = cands
    .flatMap((c) => {
      const seller = profiles.get(c.sellerBusinessId);
      const rel = fused.get(c.listingId) ?? 0;
      return seller && rel > 0 ? [{ id: c.listingId, seller, score: rel * trustFactor(seller) * locationBoost(seller.city, nq.location) }] : [];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const listings = new Map((await getListingsByIds(scored.map((s) => s.id))).map((l) => [l.id, l]));
  return scored.flatMap((s) => {
    const listing = listings.get(s.id);
    return listing ? [{ listing, seller: s.seller, score: Number(s.score.toFixed(5)), sponsored: false as const }] : [];
  });
}
