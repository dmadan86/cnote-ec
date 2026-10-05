// Fixture-corpus loaders for the relevance harness (ADR-009). The corpus is built INSIDE the run, so the harness never
// depends on seed rows. Postgres: rows are written straight into the live read database (same technique as the catalogue
// SQL tests) under fresh random category ids and removed afterwards; OpenSearch: a private alias, deleted afterwards.
// Lives outside src/ on purpose: it touches LiveListing, which @cnote/search must not do in production code (ADR-006).
import { randomUUID } from "node:crypto";
import * as ai from "@cnote/ai";
import { liveDb, toVectorLiteral } from "@cnote/live-db";
import type { IndexFilters } from "../src/filters";
import { createOpenSearchClient, OpenSearchIndex, postgresIndex, type IndexDoc, type OsClient, type SearchIndex } from "../src/index-port";
import type { CorpusItem } from "../src/relevance/format";

export interface LoadedCorpus {
  backend: "postgres" | "opensearch";
  index: SearchIndex;
  /** restricts retrieval to this corpus only */
  filters: IndexFilters;
  /** listing id -> descriptor key */
  keyOf: Map<string, string>;
  cleanup(): Promise<void>;
}

const docText = (c: CorpusItem) => `${c.title}\n${c.description}`.slice(0, 2000);

async function embedAll(corpus: CorpusItem[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < corpus.length; i += 32) out.push(...(await ai.embed(corpus.slice(i, i + 32).map(docText))).vectors);
  return out;
}

export async function loadPostgresCorpus(corpus: CorpusItem[]): Promise<LoadedCorpus> {
  const now = new Date();
  const catIds = new Map<string, string>(); // category slug -> fresh id
  const keyOf = new Map<string, string>();
  const vectors = await embedAll(corpus);
  for (const [i, c] of corpus.entries()) {
    const categoryId = catIds.get(c.category.slug) ?? randomUUID();
    catIds.set(c.category.slug, categoryId);
    const id = randomUUID();
    keyOf.set(id, c.key);
    await liveDb.liveListing.create({
      data: {
        id, versionId: randomUUID(), version: 1, sellerBusinessId: randomUUID(), categoryId, categorySlug: `${c.category.slug}-rel`, categoryName: c.category.name,
        title: c.title, description: c.description, pricePaise: c.priceRupees ? BigInt(Math.round(c.priceRupees * 100)) : null, moq: c.moq ?? null,
        sellerName: "Fixture seller", sellerTier: 2, sellerTrustScore: 50, firstPublishedAt: now, publishedAt: now,
      },
    });
    await liveDb.$executeRaw`UPDATE live_listings SET embedding = ${toVectorLiteral(vectors[i]!)}::vector WHERE id = ${id}::uuid`;
  }
  return {
    backend: "postgres",
    index: postgresIndex,
    filters: { categoryIds: [...catIds.values()] },
    keyOf,
    cleanup: async () => void (await liveDb.liveListing.deleteMany({ where: { id: { in: [...keyOf.keys()] } } })),
  };
}

/** Needs OPENSEARCH_URL. Uses a private alias (never `listings`), so it is safe next to real data. */
export async function loadOpenSearchCorpus(corpus: CorpusItem[]): Promise<LoadedCorpus> {
  const client = createOpenSearchClient();
  const alias = `relevance_${randomUUID().slice(0, 8)}`;
  const index = new OpenSearchIndex(client as unknown as OsClient, { alias, replicas: 0 });
  const vectors = await embedAll(corpus);
  const keyOf = new Map<string, string>();
  const catIds = new Map<string, string>();
  const docs: IndexDoc[] = corpus.map((c, i) => {
    const categoryId = catIds.get(c.category.slug) ?? randomUUID();
    catIds.set(c.category.slug, categoryId);
    const listingId = randomUUID();
    keyOf.set(listingId, c.key);
    return {
      listingId, sellerBusinessId: randomUUID(), categoryId, categorySlug: `${c.category.slug}-rel`, categoryName: c.category.name, title: c.title, description: c.description,
      city: null, state: null, verificationTier: 2, trustScore: 50, badgeActive: false, pricePaise: c.priceRupees ? Math.round(c.priceRupees * 100) : null,
      moq: c.moq ?? null, embedding: vectors[i], updatedAt: new Date().toISOString(),
    };
  });
  await index.upsert(docs);
  await client.indices.refresh({ index: `${alias}_v1` });
  return {
    backend: "opensearch",
    index,
    filters: { categoryIds: [...catIds.values()] },
    keyOf,
    cleanup: async () => void (await client.indices.delete({ index: `${alias}_v1` }).catch(() => undefined)),
  };
}
