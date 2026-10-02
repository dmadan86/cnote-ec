import { cached } from "@cnote/core";
import { Prisma, liveDb, toVectorLiteral } from "@cnote/live-db";
import { isUuid } from "./mappers";

// Every read here hits the LIVE database: live_listings holds only published, approved projections.

/**
 * Buyer-facing filters (search facets). All optional; absent = no constraint. Seller facts (tier, state, city) come from the
 * seller snapshot on the live row, which is re-projected on trust/verification events. Places are matched lower-cased.
 */
export interface ListingFilters {
  /** category ids, already expanded with subcategories by the caller */
  categoryIds?: string[];
  minTier?: number;
  states?: string[];
  cities?: string[];
  priceMinPaise?: number;
  priceMaxPaise?: number;
  /** listings with no stated MOQ always qualify */
  maxMoq?: number;
  hasPrice?: boolean;
}

const int = (n: number) => Math.trunc(n);
const lowerList = (xs: string[]) => Prisma.join(xs.map((x) => Prisma.sql`${x.toLowerCase()}`));

function listingFilters(f: ListingFilters | undefined): Prisma.Sql[] {
  if (!f) return [];
  const parts: Prisma.Sql[] = [];
  if (f.categoryIds) {
    const ids = f.categoryIds.filter(isUuid);
    parts.push(ids.length ? Prisma.sql`AND l.category_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.sql`AND FALSE`);
  }
  if (f.minTier) parts.push(Prisma.sql`AND l.seller_tier >= ${int(f.minTier)}::int`);
  if (f.states?.length) parts.push(Prisma.sql`AND lower(l.seller_state) IN (${lowerList(f.states)})`);
  if (f.cities?.length) parts.push(Prisma.sql`AND lower(l.seller_city) IN (${lowerList(f.cities)})`);
  if (f.hasPrice) parts.push(Prisma.sql`AND l.price_paise IS NOT NULL`);
  if (f.priceMinPaise !== undefined) parts.push(Prisma.sql`AND l.price_paise >= ${int(f.priceMinPaise)}::bigint`);
  if (f.priceMaxPaise !== undefined) parts.push(Prisma.sql`AND l.price_paise <= ${int(f.priceMaxPaise)}::bigint`);
  if (f.maxMoq !== undefined) parts.push(Prisma.sql`AND (l.moq IS NULL OR l.moq <= ${int(f.maxMoq)}::int)`);
  return parts;
}

function filters(categoryId?: string | null, excludeSellerIds?: string[], listing?: ListingFilters) {
  const parts: Prisma.Sql[] = listingFilters(listing);
  if (categoryId && isUuid(categoryId)) parts.push(Prisma.sql`AND l.category_id = ${categoryId}::uuid`);
  const ex = (excludeSellerIds ?? []).filter(isUuid);
  if (ex.length) parts.push(Prisma.sql`AND l.seller_business_id NOT IN (${Prisma.join(ex.map((id) => Prisma.sql`${id}::uuid`))})`);
  return parts.length ? Prisma.join(parts, " ") : Prisma.empty;
}

/** Runs an HNSW scan with a wider candidate pool so category/seller filters and dedupe still leave enough rows. */
async function knn<T>(query: (ef: number) => Prisma.Sql, ef: number): Promise<T[]> {
  const [, rows] = await liveDb.$transaction([
    liveDb.$executeRaw`SELECT set_config('hnsw.ef_search', ${String(ef)}, true), set_config('hnsw.iterative_scan', 'relaxed_order', true)`,
    liveDb.$queryRaw<T[]>(query(ef)),
  ]);
  return rows as T[];
}

/** ADR-002: one best listing per seller. HNSW-ordered scan over a larger pool, then DISTINCT ON seller in SQL. */
export async function findSellerCandidates(opts: {
  embedding: number[];
  categoryId: string | null;
  limit: number;
  excludeSellerIds?: string[];
}): Promise<{ sellerBusinessId: string; listingId: string; similarity: number }[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(opts.limit)));
  const pool = Math.min(1000, Math.max(limit * 10, 100)); // several listings per seller are common; pool must cover them
  const q = toVectorLiteral(opts.embedding);
  const rows = await knn<{ seller_business_id: string; id: string; dist: number }>(
    () => Prisma.sql`
      WITH near AS (
        SELECT l.id, l.seller_business_id, (l.embedding <=> ${q}::vector) AS dist
        FROM live_listings l
        WHERE l.embedding IS NOT NULL ${filters(opts.categoryId, opts.excludeSellerIds)}
        ORDER BY l.embedding <=> ${q}::vector
        LIMIT ${pool}
      ), best AS (
        SELECT DISTINCT ON (seller_business_id) id, seller_business_id, dist
        FROM near ORDER BY seller_business_id, dist
      )
      SELECT id, seller_business_id, dist FROM best ORDER BY dist LIMIT ${limit}`,
    pool,
  );
  return rows.map((r) => ({ sellerBusinessId: r.seller_business_id, listingId: r.id, similarity: 1 - Number(r.dist) }));
}

/** Tokens safe to inject into to_tsquery: letters, combining marks (Indic vowel signs) and digits only. */
export function tokens(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).filter((t) => t.length >= 2))].slice(0, 12);
}

/** Cross-script variants: at most 6, each cut to 300 chars, blank/duplicate/identical-to-original dropped. */
export function cleanVariants(text: string, variants: string[] | undefined): string[] {
  const seen = new Set([text.trim().toLowerCase()]);
  const out: string[] = [];
  for (const v of variants ?? []) {
    const t = v.trim().slice(0, 300);
    const k = t.toLowerCase();
    if (!t || seen.has(k) || !tokens(t).length) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Exact word forms for a variant token: itself, +s, and -s. Exact (not prefix) on purpose: a transliteration such as
 * "batte" must not prefix-match "battery". The 'simple' FTS config does no stemming, hence the plural handling
 * (the lexicon's canonical English is singular, listings say "Chairs").
 */
export function variantForms(t: string): string[] {
  return [...new Set([t, `${t}s`, ...(t.length > 3 && t.endsWith("s") ? [t.slice(0, -1)] : [])])];
}

/**
 * Lexical: websearch AND-semantics query (precise) OR a looser any-term query (recall). Short queries (≤3 terms)
 * get prefix matching so typeahead-ish input like "cotton tsh" still hits. ts_rank_cd scores; AND matches weigh double.
 * Returns the raw score in `lexicalRank` (0 when absent); rank ordering is search's job.
 */
/** The three tsqueries lexical retrieval uses; null when the text and variants yield no usable token. */
function lexicalQueries(text: string, variants: string[]): { strict: Prisma.Sql; loose: Prisma.Sql; variant: Prisma.Sql } | null {
  const vars = cleanVariants(text, variants);
  const toks = tokens(text);
  const varToks = [...new Set(vars.flatMap((v) => tokens(v)))].slice(0, 24);
  if (!toks.length && !varToks.length) return null;
  const prefix = toks.length <= 3;
  const orQuery = [...toks.filter((t) => t.length >= 3 || toks.length === 1).map((t) => (prefix ? `${t}:*` : t)), ...varToks.filter((t) => t.length >= 3 || vars.length === 1).flatMap(variantForms)].join(" | ");
  const orSql = orQuery ? Prisma.sql`to_tsquery('simple', ${orQuery})` : Prisma.sql`''::tsquery`;
  // Variants (transliteration, cross-script lexicon) form an OR of AND-of-word queries scored at 1.5x: below the buyer's
  // own words (2x) but above the loose any-term match.
  const varQueries = vars.map((v) => tokens(v).map((t) => `(${variantForms(t).join(" | ")})`).join(" & "));
  const varSql = varQueries.length ? Prisma.join(varQueries.map((v) => Prisma.sql`to_tsquery('simple', ${v})`), " || ") : Prisma.sql`''::tsquery`;
  return { strict: Prisma.sql`websearch_to_tsquery('simple', ${text})`, loose: orSql, variant: varSql };
}

async function lexical(text: string, categoryId: string | null | undefined, limit: number, variants: string[] = [], listing?: ListingFilters): Promise<Map<string, { score: number; seller: string }>> {
  const qs = lexicalQueries(text, variants);
  if (!qs) return new Map();
  const rows = await liveDb.$queryRaw<{ id: string; seller_business_id: string; score: number }[]>`
    WITH q AS (SELECT ${qs.strict} AS strict, ${qs.loose} AS loose, ${qs.variant} AS var)
    SELECT l.id, l.seller_business_id, (2 * ts_rank_cd(l.search_tsv, q.strict) + ts_rank_cd(l.search_tsv, q.loose) + 1.5 * ts_rank_cd(l.search_tsv, q.var))::float8 AS score
    FROM live_listings l, q
    WHERE (l.search_tsv @@ q.strict OR l.search_tsv @@ q.loose OR l.search_tsv @@ q.var) ${filters(categoryId, undefined, listing)}
    ORDER BY score DESC LIMIT ${limit}`;
  return new Map(rows.map((r) => [r.id, { score: Number(r.score), seller: r.seller_business_id }]));
}

async function vector(embedding: number[], categoryId: string | null | undefined, limit: number, listing?: ListingFilters): Promise<Map<string, { score: number; seller: string }>> {
  const q = toVectorLiteral(embedding);
  const rows = await knn<{ id: string; seller_business_id: string; dist: number }>(
    () => Prisma.sql`
      SELECT l.id, l.seller_business_id, (l.embedding <=> ${q}::vector) AS dist FROM live_listings l
      WHERE l.embedding IS NOT NULL ${filters(categoryId, undefined, listing)}
      ORDER BY l.embedding <=> ${q}::vector LIMIT ${limit}`,
    Math.max(100, limit * 2),
  );
  return new Map(rows.map((r) => [r.id, { score: 1 - Number(r.dist), seller: r.seller_business_id }]));
}

export async function retrieveListings(opts: {
  text?: string;
  embedding?: number[];
  categoryId?: string | null;
  /** buyer filters pushed into both the lexical and the vector query */
  filters?: ListingFilters;
  limit: number;
  /** extra lexical-only query strings (transliteration variants); the embedding is never built from them */
  variants?: string[];
}): Promise<{ listingId: string; sellerBusinessId: string; lexicalRank: number; similarity: number }[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(opts.limit)));
  const [lex, vec] = await Promise.all([
    opts.text?.trim() || opts.variants?.length ? lexical((opts.text ?? "").trim().slice(0, 300), opts.categoryId, limit, opts.variants, opts.filters) : new Map<string, { score: number; seller: string }>(),
    opts.embedding ? vector(opts.embedding, opts.categoryId, limit, opts.filters) : new Map<string, { score: number; seller: string }>(),
  ]);
  const ids = [...new Set([...lex.keys(), ...vec.keys()])];
  return ids.map((id) => ({ listingId: id, sellerBusinessId: (lex.get(id) ?? vec.get(id))!.seller, lexicalRank: lex.get(id)?.score ?? 0, similarity: vec.get(id)?.score ?? 0 }));
}

export interface FacetRow {
  categoryId: string;
  categorySlug: string;
  tier: number;
  state: string | null;
  city: string | null;
  pricePaise: number | null;
  moq: number | null;
}

const FACET_POOL_MAX = 2000;

/**
 * The rows facet counts are built from: every live listing that lexically matches the query (the same match the results use),
 * with NO buyer filters applied, because facet counts are disjunctive (each dimension ignores its own filter). The caller
 * filters and tallies in memory. Capped at 2000 rows, so counts on enormous result sets are approximate (lexical match only).
 * A blank query yields the whole catalogue (still capped).
 */
export async function retrieveFacetRows(opts: { text?: string; variants?: string[]; categoryId?: string | null; limit?: number }): Promise<FacetRow[]> {
  const limit = Math.max(1, Math.min(FACET_POOL_MAX, Math.trunc(opts.limit ?? FACET_POOL_MAX)));
  const text = (opts.text ?? "").trim().slice(0, 300);
  const qs = text || opts.variants?.length ? lexicalQueries(text, opts.variants ?? []) : null;
  if ((text || opts.variants?.length) && !qs) return [];
  const where = qs ? Prisma.sql`(l.search_tsv @@ ${qs.strict} OR l.search_tsv @@ ${qs.loose} OR l.search_tsv @@ ${qs.variant})` : Prisma.sql`TRUE`;
  const rows = await liveDb.$queryRaw<{ category_id: string; category_slug: string; seller_tier: number; seller_state: string | null; seller_city: string | null; price_paise: bigint | null; moq: number | null }[]>`
    SELECT l.category_id, l.category_slug, l.seller_tier, l.seller_state, l.seller_city, l.price_paise, l.moq
    FROM live_listings l WHERE ${where} ${filters(opts.categoryId)} LIMIT ${limit}`;
  return rows.map((r) => ({ categoryId: r.category_id, categorySlug: r.category_slug, tier: Number(r.seller_tier), state: r.seller_state, city: r.seller_city, pricePaise: r.price_paise == null ? null : Number(r.price_paise), moq: r.moq }));
}

/** Typeahead over live listing titles: word-prefix match, cached briefly per prefix. */
export async function suggestListingTitles(prefix: string, limit = 8): Promise<string[]> {
  const p = prefix.trim().toLowerCase().slice(0, 50);
  if (!p) return [];
  const n = Math.max(1, Math.min(20, Math.trunc(limit)));
  return cached(`catalogue:titles:${n}:${p}`, 120, async () => {
    const esc = p.replace(/[\\%_]/g, "\\$&");
    const rows = await liveDb.$queryRaw<{ title: string }[]>`
      SELECT title FROM (
        SELECT DISTINCT ON (lower(l.title)) l.title, l.first_published_at FROM live_listings l
        WHERE (lower(l.title) LIKE ${esc + "%"} OR lower(l.title) LIKE ${"% " + esc + "%"})
        ORDER BY lower(l.title), l.first_published_at DESC
      ) t ORDER BY (lower(title) LIKE ${esc + "%"}) DESC, first_published_at DESC LIMIT ${n}`;
    return rows.map((r) => r.title);
  });
}
