import { retrieveFacetRows, retrieveListings } from "@cnote/catalogue";
import { computeFacets } from "../filters";
import type { IndexHealth, ReindexResult, SearchFacets, SearchIndex, SearchIndexQuery, SearchIndexResult, IndexDoc } from "./types";

/** Postgres reads the live catalogue tables (FTS + pgvector), so there is nothing to index: writes are no-ops. */
export const postgresIndex: SearchIndex = {
  backend: "postgres",
  async search(q: SearchIndexQuery): Promise<SearchIndexResult> {
    const filters = q.filters;
    const [rows, facets] = await Promise.all([
      retrieveListings({ text: q.text, embedding: q.embedding, categoryId: q.categoryId, ...(filters ? { filters } : {}), limit: q.limit, ...(q.variants?.length ? { variants: q.variants } : {}) }),
      facetsFor(q),
    ]);
    return {
      hits: rows.map((r) => ({ listingId: r.listingId, sellerBusinessId: r.sellerBusinessId, lexicalScore: r.lexicalRank, vectorScore: r.similarity })),
      nextCursor: null,
      ...(facets ? { facets } : {}),
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

/** Facets are best-effort: a failure here never fails the search itself. */
async function facetsFor(q: SearchIndexQuery): Promise<SearchFacets | undefined> {
  try {
    const f = q.filters ?? {};
    // legacy single-category callers: the category is a scope for the facet pool, not a disjunctive filter
    const rows = await retrieveFacetRows({ text: q.text, variants: q.variants, categoryId: f.categoryIds ? null : q.categoryId });
    return computeFacets(rows, f);
  } catch {
    return undefined;
  }
}
