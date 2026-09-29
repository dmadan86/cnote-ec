// Public read helpers for the human review queue (ops UIs); avoid cross-module table reads.
import { prisma } from "@cnote/db";
import type { ReviewItemView } from "./index";

/** Any review item (open or resolved) by id; null when it doesn't exist. */
export async function getReview(id: string): Promise<(ReviewItemView & { status: "open" | "approved" | "rejected" }) | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await prisma.reviewItem.findUnique({ where: { id }, include: { aiDecision: { select: { confidence: true, output: true } } } });
  if (!r) return null;
  return {
    id: r.id, capability: r.capability, subjectType: r.subjectType, subjectId: r.subjectId, reason: r.reason,
    confidence: r.aiDecision?.confidence ?? null, output: r.aiDecision?.output ?? null, createdAt: r.createdAt.toISOString(),
    status: r.status as "open" | "approved" | "rejected",
  };
}

/** Exact count of open review items, optionally narrowed to a subject type ("listing", "enquiry", ...). */
export async function countOpenReviews(bySubjectType?: string): Promise<number> {
  return prisma.reviewItem.count({ where: { status: "open", ...(bySubjectType ? { subjectType: bySubjectType } : {}) } });
}
