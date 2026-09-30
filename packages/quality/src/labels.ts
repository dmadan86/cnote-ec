// Golden-set labelling (ADR-015 accuracy gate). Staff (privilege quality.review, enforced by the admin app) label what
// the truth was for each per-check result; accuracy per category is computed from these labels.
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import type { InspectionCheck, InspectionResult } from "@cnote/ai";
import type { ExpectedSpec } from "./types";

const UUID = /^[0-9a-f-]{36}$/i;
const OUTCOMES: InspectionResult[] = ["consistent", "inconsistent", "inconclusive"];

export interface LabellingItem {
  resultId: string;
  checkId: string;
  orderId: string;
  categorySlug: string;
  check: InspectionCheck;
  result: InspectionResult;
  confidence: number;
  note: string;
  label: InspectionResult | null;
  expected: ExpectedSpec;
  mediaIds: string[];
  completedAt: string | null;
}

export async function listForLabelling(opts: { categorySlug?: string; unlabelledOnly?: boolean; limit?: number } = {}): Promise<LabellingItem[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const results = await prisma.qualityCheckResult.findMany({
    where: {
      ...(opts.unlabelledOnly === false ? {} : { id: { notIn: (await prisma.qualityLabel.findMany({ select: { resultId: true } })).map((l) => l.resultId) } }),
      ...(opts.categorySlug ? { checkId: { in: (await prisma.qualityCheck.findMany({ where: { categorySlug: opts.categorySlug }, select: { id: true } })).map((c) => c.id) } } : {}),
    },
    orderBy: { createdAt: "desc" }, take: limit,
  });
  if (!results.length) return [];
  const ids = [...new Set(results.map((r) => r.checkId))];
  const [checks, labels, media] = await Promise.all([
    prisma.qualityCheck.findMany({ where: { id: { in: ids } } }),
    prisma.qualityLabel.findMany({ where: { resultId: { in: results.map((r) => r.id) } } }),
    prisma.qualityCheckMedia.findMany({ where: { checkId: { in: ids }, purgedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true, checkId: true } }),
  ]);
  return results.flatMap((r) => {
    const c = checks.find((x) => x.id === r.checkId);
    if (!c) return [];
    return [{
      resultId: r.id, checkId: r.checkId, orderId: c.orderId, categorySlug: c.categorySlug, check: r.check as InspectionCheck, result: r.result as InspectionResult,
      confidence: r.confidence, note: r.note, label: (labels.find((l) => l.resultId === r.id)?.label as InspectionResult | undefined) ?? null,
      expected: c.expectedSpec as unknown as ExpectedSpec, mediaIds: media.filter((m) => m.checkId === r.checkId).map((m) => m.id), completedAt: c.completedAt?.toISOString() ?? null,
    }];
  });
}

/** Records (or replaces) the staff ground-truth label for one result. */
export async function labelResult(staffId: string, resultId: string, label: string): Promise<void> {
  if (!UUID.test(resultId)) throw new DomainError("not_found", "Result not found");
  if (!(OUTCOMES as string[]).includes(label)) throw new DomainError("validation", "Label must be consistent, inconsistent or inconclusive");
  const r = await prisma.qualityCheckResult.findUnique({ where: { id: resultId } });
  if (!r) throw new DomainError("not_found", "Result not found");
  const c = await prisma.qualityCheck.findUniqueOrThrow({ where: { id: r.checkId }, select: { categorySlug: true } });
  await prisma.qualityLabel.upsert({
    where: { resultId },
    create: { resultId, checkId: r.checkId, check: r.check, categorySlug: c.categorySlug, label: label as InspectionResult, labelledBy: staffId },
    update: { label: label as InspectionResult, labelledBy: staffId },
  });
}
