// Relevance judgement file format (ADR-009). One JSON shape serves both the committed CI fixture and the files staff export
// from the admin console:
//
//   { "version": 1,
//     "corpus":   [ { key, title, description, category: { slug, name }, priceRupees?, moq?, tier?, city? } ],   // fixtures only
//     "products": { "<key>": { title, categorySlug } },                                                         // exports only
//     "queries":  [ { id, query, lang, relevant: { "<key>": 0..3 } } ] }
//
// Items are identified by a seed-independent DESCRIPTOR KEY (the slug of the listing's title), never by a database id, so a
// file keeps its meaning when the catalogue changes. Grades: 3 ideal, 2 relevant, 1 related, 0 / absent not relevant.
import { z } from "zod";

export const GRADES = [0, 1, 2, 3] as const;

export const productKeyOf = (title: string): string =>
  title.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 120);

/** Dedupe key of a query: folded like the search pipeline folds it. */
export const queryKeyOf = (q: string): string => q.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);

const grade = z.number().int().min(0).max(3);
const corpusItem = z.object({
  key: z.string().min(1).max(120),
  title: z.string().min(2).max(200),
  description: z.string().max(2000).default(""),
  category: z.object({ slug: z.string().min(1).max(100), name: z.string().min(1).max(100) }),
  priceRupees: z.number().positive().optional(),
  moq: z.number().int().positive().optional(),
});
const query = z.object({
  id: z.string().min(1).max(100),
  query: z.string().min(1).max(500),
  lang: z.string().min(2).max(10),
  relevant: z.record(z.string(), grade),
});

export const relevanceFileSchema = z.object({
  version: z.literal(1),
  description: z.string().optional(),
  corpus: z.array(corpusItem).optional(),
  products: z.record(z.string(), z.object({ title: z.string(), categorySlug: z.string().nullable() })).optional(),
  queries: z.array(query).min(1),
});
export type RelevanceFile = z.infer<typeof relevanceFileSchema>;
export type CorpusItem = z.infer<typeof corpusItem>;
export type RelevanceQuery = z.infer<typeof query>;

/** Parses and cross-checks a file: unique ids, and every graded key must exist in `corpus` when a corpus is present. */
export function parseRelevanceFile(raw: unknown): RelevanceFile {
  const f = relevanceFileSchema.parse(raw);
  const ids = new Set<string>();
  for (const q of f.queries) {
    if (ids.has(q.id)) throw new Error(`duplicate query id "${q.id}"`);
    ids.add(q.id);
  }
  if (f.corpus) {
    const keys = new Set<string>();
    for (const c of f.corpus) {
      if (keys.has(c.key)) throw new Error(`duplicate corpus key "${c.key}"`);
      keys.add(c.key);
    }
    for (const q of f.queries) for (const k of Object.keys(q.relevant)) if (!keys.has(k)) throw new Error(`query "${q.id}" grades unknown corpus key "${k}"`);
  }
  return f;
}
