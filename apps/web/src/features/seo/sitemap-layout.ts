import "server-only";
import { loadListingCount, loadSellerIndex } from "@/features/search/data";

/** Google's limit is 50k URLs per sitemap; we use 10k so every file stays small and cheap to regenerate. */
export const CHUNK = 10_000;

export type SitemapKind = { kind: "core" } | { kind: "manufacturers"; chunk: number } | { kind: "products"; chunk: number };

/**
 * Sitemap id space (generateSitemaps ids): 0 = static pages + categories + curated landing pages,
 * then one id per 10k manufacturers, then one id per 10k live products.
 */
export async function sitemapLayout(): Promise<{ ids: number[]; kindOf: (id: number) => SitemapKind }> {
  const listings = await loadListingCount();
  const productChunks = Math.max(1, Math.ceil(listings / CHUNK));
  let mChunks = 1;
  while (mChunks < 50 && (await loadSellerIndex(mChunks * CHUNK, 1)).length === 1) mChunks++; // probe for a next chunk
  const ids = Array.from({ length: 1 + mChunks + productChunks }, (_, i) => i);
  const kindOf = (id: number): SitemapKind => (id === 0 ? { kind: "core" } : id <= mChunks ? { kind: "manufacturers", chunk: id - 1 } : { kind: "products", chunk: id - 1 - mChunks });
  return { ids, kindOf };
}
