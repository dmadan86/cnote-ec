import { prisma, type QualityCheck } from "@cnote/db";
import type { InspectionCheck, InspectionResult } from "@cnote/ai";
import type { AdvisoryEvidence, CheckResultView, QualityCheckView } from "./types";

export const ADVISORY_DISCLAIMER =
  "Automated, advisory analysis of seller-shared photos. It is not a pass/fail decision and does not verify what was actually shipped.";

interface Parts { results: Map<string, CheckResultView[]>; media: Map<string, string[]> }

const ORDER: InspectionCheck[] = ["quantity", "labelling", "spec"];

export async function loadParts(checkIds: string[]): Promise<Parts> {
  const [results, media] = await Promise.all([
    prisma.qualityCheckResult.findMany({ where: { checkId: { in: checkIds } } }),
    prisma.qualityCheckMedia.findMany({ where: { checkId: { in: checkIds }, purgedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true, checkId: true } }),
  ]);
  const p: Parts = { results: new Map(), media: new Map() };
  for (const r of results) {
    const list = p.results.get(r.checkId) ?? [];
    list.push({ check: r.check as InspectionCheck, result: r.result as InspectionResult, confidence: r.confidence, note: r.note });
    p.results.set(r.checkId, list);
  }
  for (const list of p.results.values()) list.sort((a, b) => ORDER.indexOf(a.check) - ORDER.indexOf(b.check));
  for (const m of media) p.media.set(m.checkId, [...(p.media.get(m.checkId) ?? []), m.id]);
  return p;
}

export function toCheckView(c: QualityCheck, parts: Parts): QualityCheckView {
  return {
    id: c.id, orderId: c.orderId, sellerBusinessId: c.sellerBusinessId, categorySlug: c.categorySlug, status: c.status,
    verdict: c.verdict, confidence: c.confidence, needsReview: c.needsReview, results: parts.results.get(c.id) ?? [], mediaIds: parts.media.get(c.id) ?? [],
    createdAt: c.createdAt.toISOString(), completedAt: c.completedAt?.toISOString() ?? null, advisory: true,
  };
}

export async function getCheckView(checkId: string): Promise<QualityCheckView | null> {
  const row = await prisma.qualityCheck.findUnique({ where: { id: checkId } });
  return row ? toCheckView(row, await loadParts([row.id])) : null;
}

export async function toViews(rows: QualityCheck[]): Promise<QualityCheckView[]> {
  if (!rows.length) return [];
  const parts = await loadParts(rows.map((r) => r.id));
  return rows.map((r) => toCheckView(r, parts));
}

const UUID = /^[0-9a-f-]{36}$/i;

/** The seller's own checks for an order (all statuses, newest first). Participation is verified by the caller (order context). */
export async function listSellerChecks(sellerBusinessId: string, orderId: string): Promise<QualityCheckView[]> {
  if (!UUID.test(orderId)) return [];
  return toViews(await prisma.qualityCheck.findMany({ where: { orderId, sellerBusinessId }, orderBy: { createdAt: "desc" }, take: 20 }));
}

/**
 * PUBLIC READ FOR DISPUTES (ADR-013/015): completed checks for an order as advisory evidence. No pass/fail semantics, no
 * media handles (photos are private; staff reach them through the admin route). Callers must have authorised the order.
 */
export async function listChecksForOrder(orderId: string): Promise<AdvisoryEvidence[]> {
  if (!UUID.test(orderId)) return [];
  const rows = await prisma.qualityCheck.findMany({ where: { orderId, status: "completed" }, orderBy: { completedAt: "desc" }, take: 20 });
  if (!rows.length) return [];
  const parts = await loadParts(rows.map((r) => r.id));
  const counts = await prisma.qualityCheckMedia.groupBy({ by: ["checkId"], where: { checkId: { in: rows.map((r) => r.id) } }, _count: { _all: true } });
  const photos = new Map(counts.map((c) => [c.checkId, c._count._all]));
  return rows.map((r) => ({
    checkId: r.id, orderId: r.orderId, sellerBusinessId: r.sellerBusinessId, categorySlug: r.categorySlug,
    verdict: (r.verdict ?? "inconclusive") as InspectionResult, confidence: r.confidence ?? 0, needsReview: r.needsReview,
    results: parts.results.get(r.id) ?? [], photoCount: photos.get(r.id) ?? 0, completedAt: (r.completedAt ?? r.createdAt).toISOString(),
    advisory: true, disclaimer: ADVISORY_DISCLAIMER,
  }));
}
