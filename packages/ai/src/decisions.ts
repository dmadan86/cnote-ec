import { prisma, type Prisma } from "@cnote/db";
import { DomainError } from "@cnote/core";
import type { ProviderResult } from "./types";
import type { AiResult, Subject } from "./index";

/** Below these confidences an output goes to the human review queue (ADR-002, ADR-008). */
export const REVIEW_THRESHOLDS = { intent: 0.55, extract: 0.5, extract_image: 0.6, transcribe: 0.6, moderate: 0.7 } as const;
export type Capability = keyof typeof REVIEW_THRESHOLDS;

const json = (v: unknown) => v as Prisma.InputJsonValue;

/**
 * Runs a provider call, times it, writes the AiDecision (input must already be redacted) and, when
 * confidence is low or the caller says so, a ReviewItem in the same write.
 */
export async function runLogged<T extends object>(
  capability: Capability,
  subject: Subject,
  inputRedacted: unknown,
  run: () => Promise<ProviderResult<T>>,
  forceReview?: (out: T) => string | null,
  /** what to persist as the decision's output when the raw output holds personal data (e.g. a transcript) */
  auditOutput: (out: T) => unknown = (o) => o,
): Promise<AiResult<T>> {
  const started = performance.now();
  const r = await run();
  const latencyMs = Math.round(performance.now() - started);
  const threshold = REVIEW_THRESHOLDS[capability];
  const forced = forceReview?.(r.output) ?? null;
  const reason = forced ?? (r.confidence < threshold ? `Low confidence ${r.confidence.toFixed(2)} (< ${threshold})` : null);

  const row = await prisma.aiDecision.create({
    data: {
      capability,
      provider: r.provider,
      modelId: r.modelId,
      promptVersion: r.promptVersion,
      inputRedacted: json(inputRedacted),
      output: json(auditOutput(r.output)),
      confidence: r.confidence,
      subjectType: subject.type,
      subjectId: subject.id,
      latencyMs,
      ...(reason
        ? { reviews: { create: { capability, subjectType: subject.type, subjectId: subject.id, reason } } }
        : {}),
    },
    select: { id: true },
  });
  return { ...r.output, decisionId: row.id, confidence: r.confidence, needsReview: reason !== null };
}

// ---- Review queue ----
import type { ReviewItemView } from "./index";

type ReviewRow = Prisma.ReviewItemGetPayload<{ include: { aiDecision: { select: { confidence: true; output: true } } } }>;
const view = (r: ReviewRow): ReviewItemView => ({
  id: r.id,
  capability: r.capability,
  subjectType: r.subjectType,
  subjectId: r.subjectId,
  reason: r.reason,
  confidence: r.aiDecision?.confidence ?? null,
  output: r.aiDecision?.output ?? null,
  createdAt: r.createdAt.toISOString(),
});
const include = { aiDecision: { select: { confidence: true, output: true } } } as const;

export async function listOpenReviewsImpl(limit: number): Promise<ReviewItemView[]> {
  const rows = await prisma.reviewItem.findMany({
    where: { status: "open" }, orderBy: { createdAt: "asc" }, take: Math.max(1, Math.min(limit, 200)), include,
  });
  return rows.map(view);
}

export async function resolveReviewImpl(id: string, outcome: "approved" | "rejected", reviewerPersonId: string): Promise<ReviewItemView> {
  // updateMany with status guard makes double-resolution race-safe without a transaction
  const { count } = await prisma.reviewItem.updateMany({
    where: { id, status: "open" },
    data: { status: outcome, resolvedBy: reviewerPersonId, resolvedAt: new Date() },
  });
  const row = await prisma.reviewItem.findUnique({ where: { id }, include });
  if (!row) throw new DomainError("not_found", "Review item not found");
  if (count === 0) throw new DomainError("conflict", "Review item already resolved");
  return view(row);
}

// ---- Retention (ADR-010) ----
export const INPUT_RETENTION_DAYS = 180;

/** Keeps the decision row (audit of what was decided) but drops the input text. Idempotent. */
export async function purgeOldDecisionInputs(now = new Date(), days = INPUT_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  return prisma.$executeRaw`
    UPDATE ai_decisions SET input_redacted = '{"purged": true}'::jsonb
    WHERE created_at < ${cutoff} AND input_redacted <> '{"purged": true}'::jsonb`;
}
