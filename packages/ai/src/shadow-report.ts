// Shadow vs live comparison from the AiDecision log (ADR-008 shadow mode). Read-only; safe to run in production.
import { prisma } from "@cnote/db";
import { REVIEW_THRESHOLDS } from "./decisions";
import { DISPUTE_BRIEF_REVIEW_THRESHOLD } from "./disputes";
import { QUOTE_REVIEW_THRESHOLDS } from "./quotes";

/** Human-review thresholds per capability, including the families that keep their own constants (dispute brief, quotes). */
const THRESHOLDS: Record<string, number> = { ...REVIEW_THRESHOLDS, dispute_brief: DISPUTE_BRIEF_REVIEW_THRESHOLD, ...QUOTE_REVIEW_THRESHOLDS };

export interface ShadowSide { modelId: string; promptVersion: string; confidence: number; latencyMs: number; output: unknown }
export interface ShadowPair { capability: string; live: ShadowSide; shadow: ShadowSide }

export interface ShadowComparison {
  capability: string;
  pairs: number;
  /** pairs where the candidate call failed (logged as a shadow row with output.shadowError) */
  shadowErrors: number;
  /** moderate / inspect_dispatch: same verdict; intent: scores within 10 points; extract*: same category slug and title; extract_document: same PAN, GSTIN, Udyam and forgery-or-not;
   * dispute_brief: same recommended outcome; draft_quote / propose_counter: price within 5%; normalise_quotes: same delivery and GST terms. null when not applicable */
  agreement: number | null;
  /** moderate only: candidate said allow where live blocked, i.e. the candidate would have let a prohibited item through */
  candidateMissedBlocks: number;
  /** moderate only: candidate blocked where live allowed */
  candidateExtraBlocks: number;
  meanConfidence: { live: number; shadow: number };
  /** share of decisions below the human-review threshold; a candidate that floods the queue is not a win */
  reviewRate: { live: number; shadow: number };
  latencyMs: { liveP50: number; liveP95: number; shadowP50: number; shadowP95: number };
  models: { live: string[]; shadow: string[] };
  promptVersions: { live: string[]; shadow: string[] };
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** Nearest-rank percentile. */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

function agrees(capability: string, a: unknown, b: unknown): boolean | null {
  const x = rec(a), y = rec(b);
  if (capability === "moderate") return x.verdict === y.verdict;
  if (capability === "intent") return typeof x.score === "number" && typeof y.score === "number" ? Math.abs(x.score - y.score) <= 10 : null;
  if (capability === "extract" || capability === "extract_image") return x.categorySlug === y.categorySlug && String(x.title ?? "").toLowerCase() === String(y.title ?? "").toLowerCase();
  if (capability === "inspect_dispatch") return x.verdict === y.verdict;
  if (capability === "extract_document") {
    const f = rec(x.fields), g = rec(y.fields);
    const sigs = (o: Record<string, unknown>) => Array.isArray(o.forgerySignals) && o.forgerySignals.length > 0;
    return f.pan === g.pan && f.gstin === g.gstin && f.udyam === g.udyam && sigs(x) === sigs(y);
  }
  if (capability === "dispute_brief") return rec(x.recommendation).outcome === rec(y.recommendation).outcome;
  if (capability === "draft_quote" || capability === "propose_counter") return withinPct(x.pricePaise, y.pricePaise, 0.05);
  if (capability === "normalise_quotes") {
    const terms = (o: Record<string, unknown>) => new Map((Array.isArray(o.terms) ? o.terms : []).map((t) => [String(rec(t).quoteId), JSON.stringify([rec(t).deliveryChargePaise, rec(t).gstPercent])]));
    const a = terms(x), b = terms(y);
    return a.size > 0 && a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
  }
  return null;
}

/** Both null/absent agree; otherwise both numbers within `pct` of the live value. */
function withinPct(live: unknown, cand: unknown, pct: number): boolean | null {
  if (live == null && cand == null) return true;
  if (typeof live !== "number" || typeof cand !== "number") return false;
  return live === 0 ? cand === 0 : Math.abs(cand - live) / Math.abs(live) <= pct;
}

const uniq = (xs: string[]) => [...new Set(xs)].sort();

/** Pure summary so it is testable without a database. */
export function summariseShadowPairs(pairs: ShadowPair[]): ShadowComparison[] {
  const by = new Map<string, ShadowPair[]>();
  for (const p of pairs) by.set(p.capability, [...(by.get(p.capability) ?? []), p]);
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([capability, all]) => {
    const ok = all.filter((p) => rec(p.shadow.output).shadowError === undefined);
    const verdicts = ok.map((p) => agrees(capability, p.live.output, p.shadow.output)).filter((v): v is boolean => v !== null);
    const threshold = THRESHOLDS[capability] ?? 0.5;
    const rate = (xs: ShadowSide[]) => (xs.length ? xs.filter((s) => s.confidence < threshold).length / xs.length : 0);
    const moderate = capability === "moderate";
    return {
      capability,
      pairs: all.length,
      shadowErrors: all.length - ok.length,
      agreement: verdicts.length ? r3(verdicts.filter(Boolean).length / verdicts.length) : null,
      candidateMissedBlocks: moderate ? ok.filter((p) => rec(p.live.output).verdict === "block" && rec(p.shadow.output).verdict === "allow").length : 0,
      candidateExtraBlocks: moderate ? ok.filter((p) => rec(p.live.output).verdict === "allow" && rec(p.shadow.output).verdict === "block").length : 0,
      meanConfidence: { live: r3(mean(ok.map((p) => p.live.confidence))), shadow: r3(mean(ok.map((p) => p.shadow.confidence))) },
      reviewRate: { live: r3(rate(ok.map((p) => p.live))), shadow: r3(rate(ok.map((p) => p.shadow))) },
      latencyMs: {
        liveP50: percentile(all.map((p) => p.live.latencyMs), 50), liveP95: percentile(all.map((p) => p.live.latencyMs), 95),
        shadowP50: percentile(all.map((p) => p.shadow.latencyMs), 50), shadowP95: percentile(all.map((p) => p.shadow.latencyMs), 95),
      },
      models: { live: uniq(all.map((p) => p.live.modelId)), shadow: uniq(all.map((p) => p.shadow.modelId)) },
      promptVersions: { live: uniq(all.map((p) => p.live.promptVersion)), shadow: uniq(all.map((p) => p.shadow.promptVersion)) },
    };
  });
}

/** Loads shadow rows since `since` with the live decision they ran beside, and summarises per capability. */
export async function compareShadowDecisions(opts: { since: Date; capability?: string; limit?: number }): Promise<ShadowComparison[]> {
  const shadows = await prisma.aiDecision.findMany({
    where: { shadow: true, shadowOfId: { not: null }, createdAt: { gte: opts.since }, ...(opts.capability ? { capability: opts.capability } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(opts.limit ?? 5000, 20000)),
  });
  const liveRows = await prisma.aiDecision.findMany({ where: { id: { in: shadows.map((s) => s.shadowOfId!) } } });
  const live = new Map(liveRows.map((l) => [l.id, l]));
  const side = (r: (typeof shadows)[number]): ShadowSide => ({ modelId: r.modelId, promptVersion: r.promptVersion, confidence: r.confidence, latencyMs: r.latencyMs, output: r.output });
  return summariseShadowPairs(shadows.flatMap((s) => {
    const l = live.get(s.shadowOfId!);
    return l ? [{ capability: s.capability, live: side(l), shadow: side(s) }] : [];
  }));
}
