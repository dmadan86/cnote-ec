// OpenSearch index definition: pure builders, unit-tested. Index `listings_v<N>` behind alias `listings`.
import { readFileSync } from "node:fs";

export const ALIAS = "listings";
export const EMBEDDING_DIM = 256;
export const indexName = (version: number) => `${ALIAS}_v${version}`;
export const parseIndexVersion = (name: string): number => {
  const m = /^listings_v(\d+)$/.exec(name);
  return m ? Number(m[1]) : 0;
};

/** Reads the file-based synonym set (Solr format). One rule per line; comments and blanks dropped. */
export function loadSynonyms(path: URL | string = new URL("../../synonyms/hinglish-b2b.txt", import.meta.url)): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

export interface MappingOptions {
  /** analysis-icu plugin installed (detected via _cat/plugins). Falls back to standard + lowercase + asciifolding. */
  icu: boolean;
  dim?: number;
  synonyms?: string[];
  /** Managed package path (AWS: analyzers/F123456). When set, synonyms load from it and are hot-updatable. */
  synonymsPackagePath?: string;
  shards?: number;
  replicas?: number;
}

export function buildIndexBody(o: MappingOptions) {
  const dim = o.dim ?? EMBEDDING_DIM;
  const baseFilters = ["lowercase", o.icu ? "icu_folding" : "asciifolding"];
  const tokenizer = o.icu ? "icu_tokenizer" : "standard";
  const synonymFilter = o.synonymsPackagePath
    ? { type: "synonym_graph", synonyms_path: o.synonymsPackagePath, updateable: true }
    : { type: "synonym_graph", synonyms: o.synonyms ?? [] };
  return {
    settings: {
      index: { knn: true, number_of_shards: o.shards ?? 1, number_of_replicas: o.replicas ?? 1, refresh_interval: "5s" },
      analysis: {
        filter: {
          b2b_synonyms: synonymFilter,
          title_shingles: { type: "shingle", min_shingle_size: 2, max_shingle_size: 3, output_unigrams: false },
          edge_2_15: { type: "edge_ngram", min_gram: 2, max_gram: 15 },
        },
        normalizer: { lowercase_norm: { type: "custom", filter: ["lowercase", "asciifolding"] } },
        analyzer: {
          indic: { type: "custom", tokenizer, filter: baseFilters },
          indic_search: { type: "custom", tokenizer, filter: [...baseFilters, "b2b_synonyms"] },
          title_shingle: { type: "custom", tokenizer: "standard", filter: ["lowercase", "asciifolding", "title_shingles"] },
          title_edge: { type: "custom", tokenizer: "standard", filter: ["lowercase", "asciifolding", "edge_2_15"] },
        },
      },
    },
    mappings: {
      dynamic: "strict",
      properties: {
        listingId: { type: "keyword" },
        sellerBusinessId: { type: "keyword" },
        categoryId: { type: "keyword" },
        categorySlug: { type: "keyword" },
        categoryName: { type: "text", analyzer: "indic", search_analyzer: "indic_search" },
        title: {
          type: "text",
          analyzer: "indic",
          search_analyzer: "indic_search",
          fields: {
            shingles: { type: "text", analyzer: "title_shingle", search_analyzer: "title_shingle" },
            edge: { type: "text", analyzer: "title_edge", search_analyzer: "indic" },
          },
        },
        description: { type: "text", analyzer: "indic", search_analyzer: "indic_search" },
        city: { type: "keyword", normalizer: "lowercase_norm" },
        state: { type: "keyword", normalizer: "lowercase_norm" },
        verificationTier: { type: "keyword" },
        trustScore: { type: "float" },
        badgeActive: { type: "boolean" },
        pricePaise: { type: "long" },
        moq: { type: "long" },
        availability: { type: "keyword" },
        variantValues: { type: "keyword" },
        updatedAt: { type: "date" },
        embedding: {
          type: "knn_vector",
          dimension: dim,
          method: { name: "hnsw", space_type: "cosinesimil", engine: "lucene", parameters: { m: 16, ef_construction: 128 } },
        },
      },
    },
  };
}

export const templateBody = (o: MappingOptions) => ({ index_patterns: ["listings_v*"], template: buildIndexBody(o), priority: 10 });

/** Lucene cosinesimil score is (1 + cos) / 2; convert back to cosine similarity so MIN_SIMILARITY means the same thing. */
export const knnScoreToCosine = (score: number) => Math.max(0, 2 * score - 1);

export function toSourceDoc(d: import("./types").IndexDoc) {
  return {
    listingId: d.listingId,
    sellerBusinessId: d.sellerBusinessId,
    categoryId: d.categoryId,
    categorySlug: d.categorySlug,
    categoryName: d.categoryName,
    title: d.title,
    description: d.description,
    city: d.city,
    state: d.state,
    verificationTier: String(d.verificationTier),
    trustScore: d.trustScore,
    badgeActive: d.badgeActive,
    pricePaise: d.pricePaise,
    moq: d.moq,
    availability: d.availability ?? "in_stock",
    variantValues: d.variantValues ?? [],
    updatedAt: d.updatedAt,
    ...(d.embedding && d.embedding.length === EMBEDDING_DIM ? { embedding: d.embedding } : {}),
  };
}
