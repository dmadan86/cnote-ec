import { cachedTagged, cacheTags } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { PAGE_SIZE, QA_PAGE_SIZE } from "./constants";
import { searchText } from "./qa-validate";
import { authorNames } from "./read";
import { toMyQuestion } from "./qa";
import type { MyQuestion, Page, PublicQuestion, QaPage, SellerQuestion, UgcStatus } from "./types";

const offsetOf = (cursor?: string | null) => {
  const n = Number(cursor);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

/** An answered question is public when the question AND its answer are approved (answeredAt mirrors that). */
const publicWhere = (listingId: string, q: string): Prisma.ProductQuestionWhereInput => ({
  listingId,
  status: "approved",
  answeredAt: { not: null },
  answers: { some: { status: "approved" } },
  ...(q
    ? {
        OR: [
          { body: { contains: q, mode: "insensitive" } },
          { answers: { some: { status: "approved", body: { contains: q, mode: "insensitive" } } } },
        ],
      }
    : {}),
});

/**
 * Public answered questions of a listing, newest answer first. Optional `q` searches question and answer text.
 * Pages without a search are cached (tag `qa:<listingId>`, purged on answer/moderation/erasure); searches are
 * uncached because their cardinality is unbounded (callers rate-limit them).
 */
export async function listPublicQuestions(listingId: string, opts: { q?: string | null; cursor?: string | null; limit?: number } = {}): Promise<QaPage> {
  const take = Math.min(Math.max(opts.limit ?? QA_PAGE_SIZE, 1), PAGE_SIZE * 2);
  const skip = offsetOf(opts.cursor);
  const q = searchText(opts.q);
  if (q) return loadPublicQuestions(listingId, q, skip, take);
  return cachedTagged(
    `qa:list:v1:${listingId}:${skip}:${take}`,
    [cacheTags.qa(listingId), cacheTags.qaAll],
    60,
    () => loadPublicQuestions(listingId, "", skip, take),
    { staleSeconds: 300 },
  );
}

async function loadPublicQuestions(listingId: string, q: string, skip: number, take: number): Promise<QaPage> {
  const where = publicWhere(listingId, q);
  const [rows, total] = await Promise.all([
    prisma.productQuestion.findMany({
      where,
      include: { answers: { where: { status: "approved" }, take: 1 } },
      orderBy: [{ answeredAt: "desc" }, { id: "desc" }],
      skip,
      take: take + 1,
    }),
    prisma.productQuestion.count({ where }),
  ]);
  const page = rows.slice(0, take);
  const askerName = await authorNames(page.map((r) => ({ authorPersonId: r.authorPersonId, authorBusinessId: r.authorBusinessId })));
  const sellerName = await authorNames(page.flatMap((r) => (r.answers[0] ? [{ authorPersonId: r.answers[0].authorPersonId, authorBusinessId: r.answers[0].sellerBusinessId, isSeller: true }] : [])));
  const items: PublicQuestion[] = page.flatMap((r) => {
    const a = r.answers[0];
    if (!a || !r.answeredAt) return [];
    return [{
      id: r.id, body: r.body, authorName: askerName(r), askedAt: r.createdAt.toISOString(),
      answer: { id: a.id, body: a.body, answeredAt: r.answeredAt.toISOString(), sellerName: sellerName({ authorPersonId: a.authorPersonId, authorBusinessId: a.sellerBusinessId, isSeller: true }), helpfulCount: a.helpfulCount },
    }];
  });
  return { items, nextCursor: rows.length > take ? String(skip + take) : null, total };
}

/** The person's own questions on a listing in every state (pending ones are visible only to them until answered). */
export async function listMyQuestions(listingId: string, personId: string): Promise<MyQuestion[]> {
  const rows = await prisma.productQuestion.findMany({
    where: { listingId, authorPersonId: personId },
    include: { answers: { where: { status: "approved" }, take: 1 } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 20,
  });
  return rows.map((r) => toMyQuestion(r, r.answers[0] ?? null));
}

export interface SellerQuestionFilters {
  /** only questions the seller still has to answer (no answer, or the answer was rejected) */
  needsAnswer?: boolean;
  listingId?: string;
  cursor?: string | null;
  limit?: number;
}

const NEEDS_ANSWER: Prisma.ProductQuestionWhereInput = { OR: [{ answers: { none: {} } }, { answers: { some: { status: "rejected" } } }] };
const HAS_ANSWER: Prisma.ProductQuestionWhereInput = { answers: { some: { status: { not: "rejected" } } } };

/** Questions waiting on the seller (the nav badge). Held-for-moderation questions are not shown to sellers. */
export async function countUnansweredQuestions(sellerBusinessId: string): Promise<number> {
  return prisma.productQuestion.count({ where: { sellerBusinessId, status: "approved", ...NEEDS_ANSWER } });
}

/** Seller inbox, unanswered first (oldest waiting first), then answered (newest first). */
export async function listSellerQuestions(sellerBusinessId: string, filters: SellerQuestionFilters = {}): Promise<Page<SellerQuestion>> {
  const take = Math.min(Math.max(filters.limit ?? 20, 1), 50);
  const skip = offsetOf(filters.cursor);
  const base: Prisma.ProductQuestionWhereInput = { sellerBusinessId, status: "approved", ...(filters.listingId ? { listingId: filters.listingId } : {}) };
  const include = { answers: { take: 1 } } satisfies Prisma.ProductQuestionInclude;
  const waiting = { where: { AND: [base, NEEDS_ANSWER] }, include, orderBy: [{ createdAt: "asc" }, { id: "asc" }] } satisfies Prisma.ProductQuestionFindManyArgs;
  const done = { where: { AND: [base, HAS_ANSWER] }, include, orderBy: [{ createdAt: "desc" }, { id: "desc" }] } satisfies Prisma.ProductQuestionFindManyArgs;

  let rows: Prisma.ProductQuestionGetPayload<{ include: { answers: true } }>[];
  if (filters.needsAnswer) {
    rows = await prisma.productQuestion.findMany({ ...waiting, skip, take: take + 1 });
  } else {
    const waitingCount = await prisma.productQuestion.count({ where: waiting.where });
    if (skip >= waitingCount) {
      rows = await prisma.productQuestion.findMany({ ...done, skip: skip - waitingCount, take: take + 1 });
    } else {
      const first = await prisma.productQuestion.findMany({ ...waiting, skip, take: take + 1 });
      const missing = take + 1 - first.length;
      rows = missing > 0 ? [...first, ...(await prisma.productQuestion.findMany({ ...done, skip: 0, take: missing }))] : first;
    }
  }
  const page = rows.slice(0, take);
  const name = await authorNames(page.map((r) => ({ authorPersonId: r.authorPersonId, authorBusinessId: r.authorBusinessId })));
  return {
    items: page.map((r) => {
      const a = r.answers[0];
      return {
        id: r.id, listingId: r.listingId, body: r.body, authorName: name(r), createdAt: r.createdAt.toISOString(),
        answer: a ? { id: a.id, body: a.body, status: a.status as UgcStatus, moderationNote: a.status === "rejected" ? a.moderationNote : null } : null,
        needsAnswer: !a || a.status === "rejected",
      };
    }),
    nextCursor: rows.length > take ? String(skip + take) : null,
  };
}
