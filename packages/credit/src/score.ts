// Score computation + snapshots (append-only). Only with consent; identical feature vectors are not re-stored.
import { createHash } from "node:crypto";
import { emit } from "@cnote/core";
import { prisma, type CreditScore } from "@cnote/db";
import { DAY_MS } from "./config";
import { hasActiveCreditConsent } from "./consent";
import { CREDIT_MODEL_VERSION, computeScore, featureKey, type Band, type CreditFeatures, type Reason } from "./model";
import { ports } from "./ports";
import type { ScoreView } from "./types";

export async function gatherFeatures(businessId: string, now = new Date()): Promise<CreditFeatures> {
  const p = ports();
  const [gst, trust, esc, disp] = await Promise.all([p.gst(businessId), p.trust(businessId), p.escrowHistory(businessId), p.disputes(businessId)]);
  return {
    gstVerified: gst.verified,
    gstActive: gst.verified && (gst.status ?? "").toLowerCase() === "active",
    gstVerifiedAgeDays: gst.verified && gst.lastCheckedAt ? Math.max(0, Math.floor((now.getTime() - gst.lastCheckedAt.getTime()) / DAY_MS)) : null,
    gstFilingsTotal: gst.filings.length,
    gstFilingsFiled: gst.filings.filter((f) => f.filed).length,
    escrowCompleted: esc.completed,
    escrowVolumePaise: esc.completedPaise,
    escrowClean: Math.min(esc.clean, esc.completed),
    escrowRefunded: esc.refunded,
    disputesLost: disp.lost,
    disputesOpen: disp.open,
    trustScore: trust.trustScore,
    badgeActive: trust.badgeActive,
  };
}

export const toScoreView = (r: CreditScore): ScoreView => ({
  id: r.id, businessId: r.businessId, score: r.score, band: r.band as Band, modelVersion: r.modelVersion,
  reasons: r.reasons as unknown as Reason[], computedAt: r.computedAt.toISOString(), trigger: r.trigger,
});

export async function getLatestScore(businessId: string): Promise<ScoreView | null> {
  const r = await prisma.creditScore.findFirst({ where: { businessId }, orderBy: { computedAt: "desc" } });
  return r ? toScoreView(r) : null;
}

export async function listScoreHistory(businessId: string, limit = 12): Promise<ScoreView[]> {
  const rows = await prisma.creditScore.findMany({ where: { businessId }, orderBy: { computedAt: "desc" }, take: Math.min(Math.max(limit, 1), 100) });
  return rows.map(toScoreView);
}

/**
 * Compute and store a snapshot. Returns null without consent (nothing is read from GST, escrow or dispute data).
 * When the feature vector is unchanged for the current model, the latest snapshot is returned instead of a duplicate.
 */
export async function computeAndStoreScore(businessId: string, trigger: string, now = new Date()): Promise<ScoreView | null> {
  if (!(await hasActiveCreditConsent(businessId))) return null;
  const features = await gatherFeatures(businessId, now);
  const result = computeScore(features);
  const featureHash = createHash("sha256").update(`${CREDIT_MODEL_VERSION}|${featureKey(features)}`).digest("hex");
  const latest = await prisma.creditScore.findFirst({ where: { businessId }, orderBy: { computedAt: "desc" } });
  if (latest && latest.featureHash === featureHash) return toScoreView(latest);
  const row = await prisma.$transaction(async (tx) => {
    const r = await tx.creditScore.create({
      data: { businessId, score: result.score, band: result.band, modelVersion: result.modelVersion, reasons: result.reasons as never, features: features as never, featureHash, trigger, computedAt: now },
    });
    await emit(tx, "CreditScoreComputed", { type: "credit_score", id: r.id }, { businessId, score: r.score, band: r.band, modelVersion: r.modelVersion });
    return r;
  });
  return toScoreView(row);
}

/** Nightly: refresh every consenting business (bounded per run). */
export async function recomputeAllScores(now = new Date(), maxPerRun = 500): Promise<{ businesses: number; stored: number }> {
  const links = await prisma.creditConsentLink.findMany({ where: { withdrawnAt: null }, distinct: ["businessId"], select: { businessId: true }, take: maxPerRun });
  let stored = 0;
  for (const l of links) {
    const before = await prisma.creditScore.findFirst({ where: { businessId: l.businessId }, orderBy: { computedAt: "desc" }, select: { id: true } });
    const s = await computeAndStoreScore(l.businessId, "nightly", now);
    if (s && s.id !== before?.id) stored += 1;
  }
  return { businesses: links.length, stored };
}
