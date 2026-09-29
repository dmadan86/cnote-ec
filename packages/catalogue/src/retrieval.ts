import { cached } from "@cnote/core";
import { Prisma, prisma, toVectorLiteral } from "@cnote/db";
import { isUuid } from "./mappers";

const LIVE = Prisma.sql`l.status = 'published' AND l.moderation_status = 'approved'`;

function filters(categoryId?: string | null, excludeSellerIds?: string[]) {
  const parts: Prisma.Sql[] = [];
  if (categoryId && isUuid(categoryId)) parts.push(Prisma.sql`AND l.category_id = ${categoryId}::uuid`);
  const ex = (excludeSellerIds ?? []).filter(isUuid);
  if (ex.length) parts.push(Prisma.sql`AND l.seller_business_id NOT IN (${Prisma.join(ex.map((id) => Prisma.sql`${id}::uuid`))})`);
  return parts.length ? Prisma.join(parts, " ") : Prisma.empty;
}

/** Runs an HNSW scan with a wider candidate pool so category/seller filters and dedupe still leave enough rows. */
async function knn<T>(query: (ef: number) => Prisma.Sql, ef: number): Promise<T[]> {
  const [, rows] = await prisma.$transaction([
    prisma.$executeRaw`SELECT set_config('hnsw.ef_search', ${String(ef)}, true), set_config('hnsw.iterative_scan', 'relaxed_order', true)`,
    prisma.$queryRaw<T[]>(query(ef)),
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
        FROM listings l
        WHERE ${LIVE} AND l.embedding IS NOT NULL ${filters(opts.categoryId, opts.excludeSellerIds)}
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

/** Tokens safe to inject into to_tsquery: letters/digits only. */
function tokens(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 2))].slice(0, 12);
}

/**
 * Lexical: websearch AND-semantics query (precise) OR a looser any-term query (recall). Short queries (≤3 terms)
 * get prefix matching so typeahead-ish input like "cotton tsh" still hits. ts_rank_cd scores; AND matches weigh double.
 * Returns the raw score in `lexicalRank` (0 when absent); rank ordering is search's job.
 */
async function lexical(text: string, categoryId: string | null | undefined, limit: number): Promise<Map<string, number>> {
  const toks = tokens(text);
  if (!toks.length) return new Map();
  const prefix = toks.length <= 3;
  const orQuery = toks.filter((t) => t.length >= 3 || toks.length === 1).map((t) => (prefix ? `${t}:*` : t)).join(" | ");
  const orSql = orQuery ? Prisma.sql`to_tsquery('simple', ${orQuery})` : Prisma.sql`''::tsquery`;
  const rows = await prisma.$queryRaw<{ id: string; score: number }[]>`
    WITH q AS (SELECT websearch_to_tsquery('simple', ${text}) AS strict, ${orSql} AS loose)
    SELECT l.id, (2 * ts_rank_cd(l.search_tsv, q.strict) + ts_rank_cd(l.search_tsv, q.loose))::float8 AS score
    FROM listings l, q
    WHERE ${LIVE} AND (l.search_tsv @@ q.strict OR l.search_tsv @@ q.loose) ${filters(categoryId)}
    ORDER BY score DESC LIMIT ${limit}`;
  return new Map(rows.map((r) => [r.id, Number(r.score)]));
}

async function vector(embedding: number[], categoryId: string | null | undefined, limit: number): Promise<Map<string, number>> {
  const q = toVectorLiteral(embedding);
  const rows = await knn<{ id: string; dist: number }>(
    () => Prisma.sql`
      SELECT l.id, (l.embedding <=> ${q}::vector) AS dist FROM listings l
      WHERE ${LIVE} AND l.embedding IS NOT NULL ${filters(categoryId)}
      ORDER BY l.embedding <=> ${q}::vector LIMIT ${limit}`,
    Math.max(100, limit * 2),
  );
  return new Map(rows.map((r) => [r.id, 1 - Number(r.dist)]));
}

export async function retrieveListings(opts: {
  text?: string;
  embedding?: number[];
  categoryId?: string | null;
  limit: number;
}): Promise<{ listingId: string; sellerBusinessId: string; lexicalRank: number; similarity: number }[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(opts.limit)));
  const [lex, vec] = await Promise.all([
    opts.text?.trim() ? lexical(opts.text.trim().slice(0, 300), opts.categoryId, limit) : new Map<string, number>(),
    opts.embedding ? vector(opts.embedding, opts.categoryId, limit) : new Map<string, number>(),
  ]);
  const ids = [...new Set([...lex.keys(), ...vec.keys()])];
  if (!ids.length) return [];
  const sellers = await prisma.listing.findMany({ where: { id: { in: ids } }, select: { id: true, sellerBusinessId: true } });
  const sellerOf = new Map(sellers.map((s) => [s.id, s.sellerBusinessId]));
  return ids.flatMap((id) => {
    const sellerBusinessId = sellerOf.get(id);
    return sellerBusinessId ? [{ listingId: id, sellerBusinessId, lexicalRank: lex.get(id) ?? 0, similarity: vec.get(id) ?? 0 }] : [];
  });
}

/** Typeahead over live listing titles: word-prefix match, cached briefly per prefix. */
export async function suggestListingTitles(prefix: string, limit = 8): Promise<string[]> {
  const p = prefix.trim().toLowerCase().slice(0, 50);
  if (!p) return [];
  const n = Math.max(1, Math.min(20, Math.trunc(limit)));
  return cached(`catalogue:titles:${n}:${p}`, 120, async () => {
    const esc = p.replace(/[\\%_]/g, "\\$&");
    const rows = await prisma.$queryRaw<{ title: string }[]>`
      SELECT title FROM (
        SELECT DISTINCT ON (lower(l.title)) l.title, l.created_at FROM listings l
        WHERE ${LIVE} AND (lower(l.title) LIKE ${esc + "%"} OR lower(l.title) LIKE ${"% " + esc + "%"})
        ORDER BY lower(l.title), l.created_at DESC
      ) t ORDER BY (lower(title) LIKE ${esc + "%"}) DESC, created_at DESC LIMIT ${n}`;
    return rows.map((r) => r.title);
  });
}
