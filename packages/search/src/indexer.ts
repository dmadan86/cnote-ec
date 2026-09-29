import * as ai from "@cnote/ai";
import { countPublicListings, getPublicListingsByIds, listPublicListingIndex, listPublicSellerListings, type ListingView } from "@cnote/catalogue";
import type { EventHandlers, ModuleWorker } from "@cnote/core";
import { getTrustProfiles } from "@cnote/identity";
import { getSearchIndex, type IndexDoc, type SearchIndex } from "./index-port";

/**
 * Search indexer (observer). Keeps the OpenSearch index converged with the public projection. It always re-reads the
 * CURRENT public state instead of trusting the event payload, so it is idempotent and order-insensitive: replaying or
 * reordering events converges on the same doc. Writes carry an external version (ms timestamp of the read) so a slower,
 * older write can never overwrite a newer one. No-op on the Postgres backend (it reads the live tables).
 */

const EMBED_BATCH = 32;

export async function buildDocs(listings: ListingView[], now = Date.now()): Promise<IndexDoc[]> {
  if (!listings.length) return [];
  const profiles = await getTrustProfiles([...new Set(listings.map((l) => l.sellerBusinessId))]);
  const embeddings = new Map<string, number[]>();
  for (let i = 0; i < listings.length; i += EMBED_BATCH) {
    const chunk = listings.slice(i, i + EMBED_BATCH);
    try {
      const { vectors } = await ai.embed(chunk.map((l) => `${l.title}\n${l.description}`.slice(0, 2000)));
      chunk.forEach((l, j) => vectors[j] && embeddings.set(l.id, vectors[j]!));
    } catch {
      // embedding outage: index without vectors; a later event/reindex fills them in
    }
  }
  return listings.flatMap((l) => {
    const seller = profiles.get(l.sellerBusinessId);
    if (!seller) return []; // no public seller profile => not searchable (mirrors searchListings)
    return [{
      listingId: l.id,
      sellerBusinessId: l.sellerBusinessId,
      categoryId: l.category.id,
      categorySlug: l.category.slug,
      categoryName: l.category.name,
      title: l.title,
      description: l.description,
      city: seller.city,
      state: seller.state,
      verificationTier: seller.verificationTier,
      trustScore: seller.trustScore,
      badgeActive: seller.badgeActive,
      pricePaise: l.pricePaise,
      moq: l.moq,
      embedding: embeddings.get(l.id),
      updatedAt: l.updatedAt,
      version: now,
    }];
  });
}

/** Upserts the listings that are live and removes the ones that are not (or lost their seller profile). */
export async function syncListings(ids: string[], index: SearchIndex = getSearchIndex()): Promise<void> {
  if (index.backend === "postgres" || !ids.length) return;
  const unique = [...new Set(ids)];
  const now = Date.now();
  const docs = await buildDocs(await getPublicListingsByIds(unique), now);
  const live = new Set(docs.map((d) => d.listingId));
  await index.upsert(docs);
  await index.remove(unique.filter((id) => !live.has(id)));
}

async function removeListing(id: string) {
  const index = getSearchIndex();
  if (index.backend === "postgres") return;
  await index.remove([id]);
}

async function syncSeller(businessId: string) {
  const index = getSearchIndex();
  if (index.backend === "postgres") return;
  const listings = await listPublicSellerListings(businessId);
  for (let i = 0; i < listings.length; i += 200) {
    const docs = await buildDocs(listings.slice(i, i + 200));
    await index.upsert(docs);
  }
}

export const indexerHandlers: EventHandlers = {
  ListingVersionPublished: async (e) => syncListings([e.payload.listingId]),
  ListingImageModerated: async (e) => syncListings([e.payload.listingId]),
  // Withdrawals remove directly: never depend on a possibly stale cached read for a takedown.
  ListingUnpublished: async (e) => removeListing(e.payload.listingId),
  ListingArchived: async (e) => removeListing(e.payload.listingId),
  ListingModerated: async (e) => (e.payload.status === "approved" ? syncListings([e.payload.listingId]) : removeListing(e.payload.listingId)),
  TrustScoreChanged: async (e) => syncSeller(e.payload.businessId),
  BusinessVerified: async (e) => syncSeller(e.payload.businessId),
};

/** Register in apps/worker alongside the other module workers: `import { searchIndexer } from "@cnote/search"`. */
export const searchIndexer: ModuleWorker = { name: "search-indexer", handlers: indexerHandlers, jobs: [] };

/** All public listings as batches of docs (for reindexAll). */
export async function* streamAllDocs(batch = 200): AsyncGenerator<IndexDoc[]> {
  const total = await countPublicListings();
  for (let offset = 0; offset < total + batch; offset += batch) {
    const page = await listPublicListingIndex({ offset, limit: batch });
    if (!page.length) return;
    yield await buildDocs(await getPublicListingsByIds(page.map((p) => p.id)));
    if (page.length < batch) return;
  }
}

export async function reindexAll(index: SearchIndex = getSearchIndex()) {
  return index.reindexAll(streamAllDocs());
}
