import { retrieveListings } from "@cnote/catalogue";
import type { IndexHealth, ReindexResult, SearchIndex, SearchIndexQuery, SearchIndexResult, IndexDoc } from "./types";

/** Postgres reads the live catalogue tables (FTS + pgvector), so there is nothing to index: writes are no-ops. */
export const postgresIndex: SearchIndex = {
  backend: "postgres",
  async search(q: SearchIndexQuery): Promise<SearchIndexResult> {
    const rows = await retrieveListings({ text: q.text, embedding: q.embedding, categoryId: q.categoryId, limit: q.limit, ...(q.variants?.length ? { variants: q.variants } : {}) });
    return {
      hits: rows.map((r) => ({ listingId: r.listingId, sellerBusinessId: r.sellerBusinessId, lexicalScore: r.lexicalRank, vectorScore: r.similarity })),
      nextCursor: null,
    };
  },
  async upsert(_docs: IndexDoc[]) {},
  async remove(_ids: string[]) {},
  async health(): Promise<IndexHealth> {
    return { ok: true, backend: "postgres", detail: "reads live tables" };
  },
  async reindexAll(stream: AsyncIterable<IndexDoc[]>): Promise<ReindexResult> {
    for await (const _ of stream) void _; // drain so producers finish
    return { indexed: 0, failed: 0, index: null };
  },
};
