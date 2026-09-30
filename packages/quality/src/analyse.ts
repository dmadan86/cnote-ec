// Async analysis (ADR-015, ADR-008): load private photos, call ai.inspectDispatch, persist per-check advisory results and
// emit QualityCheckCompleted in one transaction. Idempotent: only one worker can claim a pending check.
import { getDecisionMeta, inspectDispatch, type InspectDispatchInput } from "@cnote/ai";
import { emit, getJobQueue } from "@cnote/core";
import { prisma } from "@cnote/db";
import { getMediaStore } from "@cnote/media";
import { ANALYSE_TOPIC, MAX_AI_IMAGES } from "./config";
import type { ExpectedSpec } from "./types";

/** At most `max` items, evenly spaced and always keeping the first and last (video frames can outnumber the model's image cap). */
export function pickEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  if (max <= 1) return items.slice(0, 1);
  return Array.from({ length: max }, (_, i) => items[Math.round((i * (items.length - 1)) / (max - 1))]!);
}

export type AnalyseOutcome = "completed" | "skipped" | "failed" | "retry";

const STUCK_MS = 15 * 60_000;

export async function analyseCheck(checkId: string, opts: { attempt?: number; maxAttempts?: number } = {}): Promise<AnalyseOutcome> {
  const claimed = await prisma.qualityCheck.updateMany({ where: { id: checkId, status: "pending" }, data: { status: "analysing" } });
  if (claimed.count === 0) return "skipped";
  const check = await prisma.qualityCheck.findUniqueOrThrow({ where: { id: checkId } });
  const fail = async (reason: string): Promise<AnalyseOutcome> => {
    await prisma.qualityCheck.update({ where: { id: checkId }, data: { status: "failed", failureReason: reason.slice(0, 300) } });
    return "failed";
  };
  try {
    const media = await prisma.qualityCheckMedia.findMany({ where: { checkId, purgedAt: null }, orderBy: { createdAt: "asc" } });
    if (!media.length) return await fail("No photos available");
    const store = getMediaStore("private");
    const objs = await Promise.all(media.map((m) => store.get(m.key)));
    if (objs.some((o) => !o)) return await fail("A photo is no longer available");
    const chosen = pickEvenly(media.map((m, i) => ({ m, o: objs[i]! })), MAX_AI_IMAGES);
    const spec = check.expectedSpec as unknown as ExpectedSpec;
    const input: InspectDispatchInput = {
      images: chosen.map(({ m, o }) => ({ bytes: o.bytes, mimeType: m.mimeType, width: m.width, height: m.height })),
      expected: { categorySlug: check.categorySlug, productTitle: spec.productTitle, quantity: spec.quantity, unit: spec.unit, requirement: spec.requirement, attributes: spec.attributes, labelling: spec.labelling },
      language: "en", ref: { orderId: check.orderId, checkId },
    };
    const r = await inspectDispatch(input, { type: "order", id: check.orderId });
    const meta = await getDecisionMeta(r.decisionId);
    await prisma.$transaction(async (tx) => {
      const done = await tx.qualityCheck.updateMany({
        where: { id: checkId, status: "analysing" },
        data: { status: "completed", verdict: r.verdict, confidence: r.confidence, needsReview: r.needsReview, decisionId: r.decisionId, promptVersion: meta?.promptVersion ?? null, modelId: meta?.modelId ?? null, completedAt: new Date() },
      });
      if (done.count === 0) return;
      await tx.qualityCheckResult.createMany({ data: r.checks.map((c) => ({ checkId, check: c.check, result: c.result, confidence: c.confidence, note: c.note })), skipDuplicates: true });
      await emit(tx, "QualityCheckCompleted", { type: "order", id: check.orderId }, {
        checkId, orderId: check.orderId, sellerBusinessId: check.sellerBusinessId, categorySlug: check.categorySlug, verdict: r.verdict, confidence: r.confidence,
      });
    });
    return "completed";
  } catch (err) {
    const last = (opts.attempt ?? 1) >= (opts.maxAttempts ?? 1);
    const msg = err instanceof Error ? err.message : String(err);
    if (last) return fail(msg);
    await prisma.qualityCheck.update({ where: { id: checkId }, data: { status: "pending", failureReason: msg.slice(0, 300) } });
    throw err; // queue retries with backoff
  }
}

/** Re-queues checks stuck in "analysing" (worker crashed mid-run). Returns how many. */
export async function requeueStuckChecks(now = new Date()): Promise<number> {
  const rows = await prisma.qualityCheck.findMany({ where: { status: "analysing", updatedAt: { lt: new Date(now.getTime() - STUCK_MS) } }, select: { id: true }, take: 100 });
  let n = 0;
  for (const r of rows) {
    const { count } = await prisma.qualityCheck.updateMany({ where: { id: r.id, status: "analysing" }, data: { status: "pending" } });
    if (count) { await getJobQueue().enqueue(ANALYSE_TOPIC, { checkId: r.id }, { dedupeKey: `analyse:${r.id}:${now.getTime()}`, maxAttempts: 3 }); n++; }
  }
  return n;
}
