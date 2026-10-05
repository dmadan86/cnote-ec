// Staff relevance judgements recorded from live search results (ADR-009), exported in the shared judgement file format
// (format.ts) so `pnpm --filter @cnote/search eval:relevance --judgements <file>` can score the live index with them.
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { productKeyOf, queryKeyOf, type RelevanceFile } from "./format";

export interface JudgementView {
  id: string;
  query: string;
  lang: string;
  productKey: string;
  listingId: string | null;
  listingTitle: string;
  categorySlug: string | null;
  grade: number;
  backend: string;
  judgedByStaffId: string;
  updatedAt: Date;
}

export interface RecordJudgementInput {
  query: string;
  lang: string;
  listingId: string | null;
  listingTitle: string;
  categorySlug: string | null;
  grade: number;
  backend: string;
  staffId: string;
}

/** en, hi, kn ..., plus the eval tags "hinglish" and "mixed" */
const LANG_RE = /^[a-z][a-z-]{1,15}$/;

/** Upserts one grade for (query, product). Re-judging overwrites, so the file always holds the latest opinion. */
export async function recordJudgement(i: RecordJudgementInput): Promise<JudgementView> {
  const query = i.query.replace(/\s+/g, " ").trim();
  const productKey = productKeyOf(i.listingTitle);
  if (!query || query.length > 500) throw new DomainError("validation", "A query of up to 500 characters is required.");
  if (!productKey) throw new DomainError("validation", "The listing needs a title.");
  if (!Number.isInteger(i.grade) || i.grade < 0 || i.grade > 3) throw new DomainError("validation", "Grade must be 0, 1, 2 or 3.");
  if (!LANG_RE.test(i.lang)) throw new DomainError("validation", "Language must be a short lower-case tag such as en, hi, hinglish or mixed.");
  const data = { query, lang: i.lang, listingId: i.listingId, listingTitle: i.listingTitle.slice(0, 200), categorySlug: i.categorySlug, grade: i.grade, backend: i.backend, judgedByStaffId: i.staffId };
  const row = await prisma.searchJudgement.upsert({
    where: { queryKey_productKey: { queryKey: queryKeyOf(query), productKey } },
    create: { queryKey: queryKeyOf(query), productKey, ...data },
    update: data,
  });
  return row;
}

export async function listJudgements(o: { query?: string; limit?: number } = {}): Promise<JudgementView[]> {
  return prisma.searchJudgement.findMany({
    where: o.query ? { queryKey: queryKeyOf(o.query) } : {},
    orderBy: [{ updatedAt: "desc" }],
    take: Math.min(500, Math.max(1, o.limit ?? 200)),
  });
}

/** Distinct judged queries with how many items are graded, newest first. */
export async function judgedQueries(limit = 100): Promise<{ query: string; lang: string; judged: number }[]> {
  const rows = await prisma.searchJudgement.groupBy({ by: ["queryKey"], _count: { _all: true }, _max: { updatedAt: true }, orderBy: { _max: { updatedAt: "desc" } }, take: limit });
  if (!rows.length) return [];
  const firsts = await prisma.searchJudgement.findMany({ where: { queryKey: { in: rows.map((r) => r.queryKey) } }, distinct: ["queryKey"], select: { queryKey: true, query: true, lang: true } });
  const by = new Map(firsts.map((f) => [f.queryKey, f]));
  return rows.flatMap((r) => {
    const f = by.get(r.queryKey);
    return f ? [{ query: f.query, lang: f.lang, judged: r._count._all }] : [];
  });
}

export async function deleteJudgement(id: string): Promise<boolean> {
  const r = await prisma.searchJudgement.deleteMany({ where: { id } });
  return r.count > 0;
}

/** The recorded judgements as a relevance file (queries with at least one grade; grade-0-only queries are kept: they are negatives). */
export async function exportJudgements(): Promise<RelevanceFile> {
  const rows = await prisma.searchJudgement.findMany({ orderBy: [{ queryKey: "asc" }, { productKey: "asc" }] });
  const queries = new Map<string, RelevanceFile["queries"][number]>();
  const products: NonNullable<RelevanceFile["products"]> = {};
  for (const r of rows) {
    let q = queries.get(r.queryKey);
    if (!q) {
      q = { id: `live-${queries.size + 1}`, query: r.query, lang: r.lang, relevant: {} };
      queries.set(r.queryKey, q);
    }
    q.relevant[r.productKey] = r.grade;
    products[r.productKey] = { title: r.listingTitle, categorySlug: r.categorySlug };
  }
  return { version: 1, description: "Staff relevance judgements exported from the admin console (ADR-009).", products, queries: [...queries.values()] };
}
