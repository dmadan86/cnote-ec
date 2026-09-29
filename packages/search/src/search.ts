import { createHash } from "node:crypto";
import * as ai from "@cnote/ai";
import { getCategoryBySlug, getPublicListingsByIds } from "@cnote/catalogue";
import { cachedTagged, cacheTags } from "@cnote/core";
import { getTrustProfiles } from "@cnote/identity";
import { z } from "zod";
import { locationBoost, rrfFuse, toCandidates, trustFactor } from "./fusion";
import { getSearchIndex, type SearchFacets } from "./index-port";
import { normaliseQuery } from "./normalise";
import type { SearchHit } from "./index";

const optsSchema = z.object({
  q: z.string().max(500),
  categorySlug: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
});

interface Page {
  hits: SearchHit[];
  nextCursor: string | null;
  facets?: SearchFacets;
}

/** `cursor`, `nextCursor` and `facets` are additive and only populated by backends that support them (OpenSearch). */
export async function searchListings(opts: { q: string; categorySlug?: string; limit?: number; cursor?: string }): Promise<{ hits: SearchHit[]; tookMs: number; nextCursor?: string | null; facets?: SearchFacets }> {
  const started = Date.now();
  const { q, categorySlug, limit, cursor } = optsSchema.parse(opts);
  const nq = normaliseQuery(q);
  const key = `search:q:v3:${createHash("sha1").update(JSON.stringify([getSearchIndex().backend, nq, categorySlug ?? null, limit, cursor ?? null])).digest("hex")}`;
  // Cached per NORMALISED query (so "boxes for cosmetics in India" and "boxes cosmetics" share one entry): 2 min fresh +
  // 10 min stale-while-revalidate. Entries are tagged with every listing/seller they contain, so a moderation/archive/trust
  // event purges exactly the results that show it (hard); new publications refresh the `search` tag softly.
  // tookMs always reflects this call.
  const page = await cachedTagged(
    key,
    (v: Page) => [cacheTags.search, ...(categorySlug ? [cacheTags.category(categorySlug)] : []), ...v.hits.flatMap((h) => [cacheTags.listing(h.listing.id), cacheTags.seller(h.seller.businessId)])],
    120,
    () => run(nq, categorySlug, limit, cursor),
    { staleSeconds: 600, softTags: [cacheTags.search] },
  );
  return { hits: page.hits, tookMs: Date.now() - started, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}), ...(page.facets ? { facets: page.facets } : {}) };
}

async function run(nq: ReturnType<typeof normaliseQuery>, categorySlug: string | undefined, limit: number, cursor: string | undefined): Promise<Page> {
  const empty: Page = { hits: [], nextCursor: null };
  let categoryId: string | null = null;
  let categoryName = "";
  if (categorySlug) {
    const cat = await getCategoryBySlug(categorySlug);
    if (!cat) return empty;
    categoryId = cat.id;
    categoryName = cat.name;
  }
  const text = nq.text || categoryName; // pure category browse falls back to the category's own text
  if (!text) return empty;

  let embedding: number[] | undefined;
  try {
    embedding = (await ai.embed([text])).vectors[0];
  } catch {
    embedding = undefined; // embedding outage degrades to lexical-only rather than failing search
  }
  const res = await getSearchIndex().search({ text, location: nq.location, embedding, categoryId, limit: Math.max(30, limit * 3), cursor });
  const cands = toCandidates(res.hits);
  if (!cands.length) return { hits: [], nextCursor: null, facets: res.facets };

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

  const listings = new Map((await getPublicListingsByIds(scored.map((s) => s.id))).map((l) => [l.id, l]));
  const hits = scored.flatMap((s) => {
    const listing = listings.get(s.id);
    return listing ? [{ listing, seller: s.seller, score: Number(s.score.toFixed(5)), sponsored: false as const }] : [];
  });
  return { hits, nextCursor: res.nextCursor, facets: res.facets };
}
