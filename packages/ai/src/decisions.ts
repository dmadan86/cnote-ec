import { prisma, type Prisma } from "@cnote/db";
import { DomainError } from "@cnote/core";
import { getShadowProviders } from "./registry";
import type { ProviderResult, Providers } from "./types";
import type { AiResult, Subject } from "./index";

/** Below these confidences an output goes to the human review queue (ADR-002, ADR-008). */
export const REVIEW_THRESHOLDS = { intent: 0.55, extract: 0.5, extract_image: 0.6, transcribe: 0.6, moderate: 0.7, extract_document: 0.75, inspect_dispatch: 0.6 } as const;
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
  /** ADR-008 shadow mode: re-runs the capability on the candidate providers (AI_SHADOW_PROVIDER), logged with shadow=true, never user-visible */
  shadow?: (p: Providers) => Promise<ProviderResult<T>>,
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
  if (shadow) {
    const candidate = getShadowProviders();
    if (candidate) startShadowRun(capability, subject, inputRedacted, row.id, () => shadow(candidate), auditOutput);
  }
  return { ...r.output, decisionId: row.id, confidence: r.confidence, needsReview: reason !== null };
}

// ---- Shadow mode (ADR-008) ----
const pendingShadows = new Set<Promise<void>>();

/**
 * Fire-and-forget: the candidate never delays or changes the live answer, and its failures are logged as shadow rows, not thrown.
 * Exported for the capabilities that have their own provider port (document, inspection, dispute brief, quotes); callers
 * resolve their candidate first (null when shadow mode is off) and only call this when there is one.
 */
export function startShadowRun<T extends object>(
  capability: string, subject: { type: string; id: string }, inputRedacted: unknown, liveId: string,
  run: () => Promise<ProviderResult<T>>, auditOutput: (out: T) => unknown = (o) => o,
): void {
  const task = logShadow(capability, subject, inputRedacted, liveId, run, auditOutput)
    .catch((err) => console.warn("[ai] shadow logging failed:", err instanceof Error ? err.message : err))
    .finally(() => pendingShadows.delete(task));
  pendingShadows.add(task);
}

async function logShadow<T extends object>(
  capability: string, subject: { type: string; id: string }, inputRedacted: unknown, liveId: string,
  run: () => Promise<ProviderResult<T>>, auditOutput: (out: T) => unknown,
): Promise<void> {
  const started = performance.now();
  const base = { capability, inputRedacted: json(inputRedacted), subjectType: subject.type, subjectId: subject.id, shadow: true, shadowOfId: liveId };
  try {
    const r = await run();
    await prisma.aiDecision.create({ data: { ...base, provider: r.provider, modelId: r.modelId, promptVersion: r.promptVersion, output: json(auditOutput(r.output)), confidence: r.confidence, latencyMs: Math.round(performance.now() - started) } });
  } catch (err) {
    await prisma.aiDecision.create({ data: { ...base, provider: process.env.AI_SHADOW_PROVIDER ?? "shadow", modelId: process.env.AI_SHADOW_MODEL_REASONING || "unknown", promptVersion: "n/a", output: json({ shadowError: err instanceof Error ? err.message : String(err) }), confidence: 0, latencyMs: Math.round(performance.now() - started) } });
  }
}

/** Resolves when every in-flight shadow decision has been written (graceful shutdown, tests, the eval CLI). */
export async function flushShadowDecisions(): Promise<void> {
  while (pendingShadows.size) await Promise.all([...pendingShadows]);
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

/** Puts a subject in the ops review queue outside a capability call (e.g. post-publication audit of a sampled auto-approval). */
export async function enqueueReviewImpl(a: { capability: Capability; subject: Subject; reason: string; decisionId?: string | null }): Promise<void> {
  await prisma.reviewItem.create({
    data: { capability: a.capability, subjectType: a.subject.type, subjectId: a.subject.id, reason: a.reason.slice(0, 500), ...(a.decisionId ? { aiDecisionId: a.decisionId } : {}) },
  });
}

/** Who answered a logged decision (provider, model, prompt version), for modules that snapshot it next to their own rows. */
export async function getDecisionMeta(decisionId: string): Promise<{ provider: string; modelId: string; promptVersion: string } | null> {
  return prisma.aiDecision.findUnique({ where: { id: decisionId }, select: { provider: true, modelId: true, promptVersion: true } });
}
