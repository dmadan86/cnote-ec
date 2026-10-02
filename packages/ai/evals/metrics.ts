// Pure report maths for the eval gate (ADR-008): calibration, latency, cost, baseline comparison, Markdown.
import type { EvalReport, Sample } from "./harness";

export const REPORT_SCHEMA = 1;

export interface Calibration {
  n: number;
  /** share of decisions sent to the human queue */
  reviewRate: number;
  accuracy: number;
  /** accuracy among decisions that skipped the human queue: the number that matters for trust */
  accuracyAutoAccepted: number | null;
  /** accuracy among decisions routed to a human: low is fine, it means the queue catches the hard cases */
  accuracyHumanRouted: number | null;
  /** wrong answers that skipped the human queue / all auto-accepted */
  autoAcceptErrorRate: number | null;
  meanConfidence: number;
  /** expected calibration error over 5 equal-width bins; 0 = confidence equals accuracy */
  ece: number;
}

export interface Latency { n: number; p50: number; p95: number }
export interface CostLine { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; usd: number | null; usdPer1kCalls: number | null }
export interface EvalRun {
  schema: number;
  provider: string;
  generatedAt: string;
  models: string[];
  metrics: Record<string, { value: number; threshold: number; pass: boolean }>;
  calibration: Record<string, Calibration>;
  latencyMs: Record<string, Latency>;
  cost: { totalUsd: number | null; perCapability: Record<string, CostLine> };
  errors: Record<string, number>;
  failures: string[];
  details: Record<string, string>;
  /** baseline files only: per-metric tolerance overrides, in the metric's own units */
  tolerance?: Record<string, number>;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Nearest-rank percentile; 0 on empty input. */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

export function calibrate(samples: Sample[]): Calibration {
  const auto = samples.filter((s) => !s.humanRouted);
  const human = samples.filter((s) => s.humanRouted);
  const acc = (xs: Sample[]) => (xs.length ? xs.filter((s) => s.correct).length / xs.length : null);
  const bins = Array.from({ length: 5 }, () => [] as Sample[]);
  for (const s of samples) bins[Math.min(4, Math.floor(s.confidence * 5))]!.push(s);
  const ece = samples.length
    ? bins.reduce((sum, b) => sum + (b.length / samples.length) * Math.abs(mean(b.map((s) => s.confidence)) - (acc(b) ?? 0)), 0)
    : 0;
  const a = acc(auto);
  return {
    n: samples.length,
    reviewRate: r3(samples.length ? human.length / samples.length : 0),
    accuracy: r3(acc(samples) ?? 0),
    accuracyAutoAccepted: a === null ? null : r3(a),
    accuracyHumanRouted: acc(human) === null ? null : r3(acc(human)!),
    autoAcceptErrorRate: a === null ? null : r3(1 - a),
    meanConfidence: r3(mean(samples.map((s) => s.confidence))),
    ece: r3(ece),
  };
}

export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; calls: number; usd: number | null }

export function buildRun(args: { provider: string; report: EvalReport; latencies: Record<string, number[]>; usage: Record<string, Usage>; models: string[]; now?: Date }): EvalRun {
  const { report } = args;
  const perCapability: Record<string, CostLine> = {};
  let total: number | null = 0;
  for (const [cap, u] of Object.entries(args.usage)) {
    perCapability[cap] = {
      calls: u.calls, inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens,
      usd: u.usd === null ? null : Math.round(u.usd * 1e6) / 1e6,
      usdPer1kCalls: u.usd === null || !u.calls ? null : Math.round((u.usd / u.calls) * 1000 * 1e4) / 1e4,
    };
    total = total === null || u.usd === null ? null : total + u.usd;
  }
  return {
    schema: REPORT_SCHEMA,
    provider: args.provider,
    generatedAt: (args.now ?? new Date()).toISOString(),
    models: args.models,
    metrics: Object.fromEntries(report.metrics.map((m) => [m.name, { value: m.value, threshold: m.threshold, pass: m.pass }])),
    calibration: Object.fromEntries(Object.entries(report.samples).filter(([, s]) => s.length).map(([cap, s]) => [cap, calibrate(s)])),
    latencyMs: Object.fromEntries(Object.entries(args.latencies).filter(([, xs]) => xs.length).map(([cap, xs]) => [cap, { n: xs.length, p50: Math.round(percentile(xs, 50)), p95: Math.round(percentile(xs, 95)) }])),
    cost: { totalUsd: total === null ? null : Math.round(total * 1e6) / 1e6, perCapability },
    errors: report.errors,
    failures: report.failures,
    details: report.details,
  };
}

// ---- baseline comparison ----

export const DEFAULT_TOLERANCE = {
  /** absolute drop allowed in a 0..1 quality metric */
  quality: 0.03,
  /** absolute rise allowed in the auto-accept error rate */
  autoAcceptError: 0.05,
  /** absolute rise allowed in the human-review rate (a flooded queue is a regression too) */
  reviewRate: 0.15,
  /** p95 may grow by this factor (plus slackMs) before it counts; real providers only, local latency is noise */
  latencyRatio: 1.5,
  latencySlackMs: 250,
  /** cost per capability may grow by this factor */
  costRatio: 1.25,
  /** absolute rise allowed in provider error rate per capability */
  errorRate: 0.02,
} as const;

export interface Finding { kind: "floor" | "regression"; key: string; message: string }
export interface Comparison { baseline: string | null; findings: Finding[]; notes: string[] }

export function compareToBaseline(run: EvalRun, baseline: EvalRun | null, cases: Record<string, number> = {}): Comparison {
  const findings: Finding[] = [];
  const notes: string[] = [];
  for (const [name, m] of Object.entries(run.metrics)) {
    if (!m.pass) findings.push({ kind: "floor", key: name, message: `${name} ${m.value} is below the hard floor ${m.threshold}` });
  }
  if (!baseline) {
    notes.push(`No committed baseline for provider "${run.provider}": only the hard floors were enforced. Create one with \`pnpm --filter @cnote/ai eval --provider ${run.provider} --update-baseline\` after reviewing the numbers.`);
    return { baseline: null, findings, notes };
  }
  const tol = (key: string, fallback: number) => baseline.tolerance?.[key] ?? fallback;
  for (const [name, b] of Object.entries(baseline.metrics)) {
    const cur = run.metrics[name];
    if (!cur) { notes.push(`${name}: in baseline but not measured this run (skipped).`); continue; }
    const allowed = tol(name, DEFAULT_TOLERANCE.quality);
    if (cur.value < b.value - allowed - 1e-9) findings.push({ kind: "regression", key: name, message: `${name} fell ${b.value} -> ${cur.value} (tolerance ${allowed})` });
  }
  for (const [cap, b] of Object.entries(baseline.calibration)) {
    const cur = run.calibration[cap];
    if (!cur) { notes.push(`calibration/${cap}: not measured this run.`); continue; }
    if (b.autoAcceptErrorRate !== null && cur.autoAcceptErrorRate !== null) {
      const allowed = tol(`calibration.${cap}.autoAcceptErrorRate`, DEFAULT_TOLERANCE.autoAcceptError);
      if (cur.autoAcceptErrorRate > b.autoAcceptErrorRate + allowed + 1e-9) findings.push({ kind: "regression", key: `calibration.${cap}.autoAcceptErrorRate`, message: `${cap}: wrong answers skipping human review rose ${b.autoAcceptErrorRate} -> ${cur.autoAcceptErrorRate} (tolerance ${allowed})` });
    }
    const allowedReview = tol(`calibration.${cap}.reviewRate`, DEFAULT_TOLERANCE.reviewRate);
    if (cur.reviewRate > b.reviewRate + allowedReview + 1e-9) findings.push({ kind: "regression", key: `calibration.${cap}.reviewRate`, message: `${cap}: human-review rate rose ${b.reviewRate} -> ${cur.reviewRate} (tolerance ${allowedReview}); the ops queue would grow` });
  }
  for (const [cap, n] of Object.entries(run.errors)) {
    const total = cases[cap] ?? 0;
    const base = baseline.errors[cap] ?? 0;
    if (!total) continue;
    const allowed = tol(`errors.${cap}`, DEFAULT_TOLERANCE.errorRate);
    if (n / total > base / total + allowed + 1e-9) findings.push({ kind: "regression", key: `errors.${cap}`, message: `${cap}: provider errors ${base} -> ${n} of ${total} calls` });
  }
  if (baseline.provider === "heuristic") notes.push("Latency and cost are not compared for the heuristic provider.");
  else {
    for (const [cap, b] of Object.entries(baseline.latencyMs)) {
      const cur = run.latencyMs[cap];
      if (!cur) continue;
      const limit = b.p95 * tol("latencyRatio", DEFAULT_TOLERANCE.latencyRatio) + DEFAULT_TOLERANCE.latencySlackMs;
      if (cur.p95 > limit) findings.push({ kind: "regression", key: `latency.${cap}`, message: `${cap}: p95 latency ${b.p95}ms -> ${cur.p95}ms (limit ${Math.round(limit)}ms)` });
    }
    for (const [cap, b] of Object.entries(baseline.cost.perCapability)) {
      const cur = run.cost.perCapability[cap];
      if (!cur || b.usd === null || cur.usd === null || b.usd === 0) continue;
      const limit = b.usd * tol("costRatio", DEFAULT_TOLERANCE.costRatio);
      if (cur.usd > limit) findings.push({ kind: "regression", key: `cost.${cap}`, message: `${cap}: estimated cost $${b.usd} -> $${cur.usd} (limit $${limit.toFixed(6)})` });
    }
  }
  return { baseline: baseline.generatedAt, findings, notes };
}

// ---- Markdown ----

const cell = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : String(v));

export function renderMarkdown(run: EvalRun, cmp: Comparison, baseline: EvalRun | null): string {
  const out: string[] = [];
  const failed = cmp.findings.length > 0;
  out.push(`# AI eval report: ${run.provider}`, "", `${failed ? "**FAILED**" : "**PASSED**"} - generated ${run.generatedAt}. Models: ${run.models.length ? run.models.join(", ") : "n/a (offline provider)"}.`, "");
  if (failed) {
    out.push("## Findings", "");
    for (const f of cmp.findings) out.push(`- **${f.kind}** \`${f.key}\`: ${f.message}`);
    out.push("");
  }
  for (const n of cmp.notes) out.push(`> ${n}`);
  if (cmp.notes.length) out.push("");
  out.push("## Quality metrics", "", "| Metric | Value | Hard floor | Baseline | Status |", "|---|---|---|---|---|");
  for (const [name, m] of Object.entries(run.metrics)) {
    const b = baseline?.metrics[name]?.value;
    const bad = cmp.findings.some((f) => f.key === name);
    out.push(`| ${name} | ${m.value} | ${m.threshold} | ${cell(b)} | ${bad ? "FAIL" : "ok"} |`);
  }
  out.push("", "## Calibration (confidence vs the human-review threshold)", "", "| Capability | Cases | Review rate | Accuracy | Auto-accepted accuracy | Human-routed accuracy | Mean confidence | ECE |", "|---|---|---|---|---|---|---|---|");
  for (const [cap, c] of Object.entries(run.calibration)) out.push(`| ${cap} | ${c.n} | ${c.reviewRate} | ${c.accuracy} | ${cell(c.accuracyAutoAccepted)} | ${cell(c.accuracyHumanRouted)} | ${c.meanConfidence} | ${c.ece} |`);
  out.push("", "## Latency (ms)", "", "| Capability | Calls | p50 | p95 |", "|---|---|---|---|");
  for (const [cap, l] of Object.entries(run.latencyMs)) out.push(`| ${cap} | ${l.n} | ${l.p50} | ${l.p95} |`);
  out.push("", "## Cost estimate", "", `Total for this run: ${run.cost.totalUsd === null ? "n/a (unpriced model)" : `$${run.cost.totalUsd}`}.`, "");
  if (Object.keys(run.cost.perCapability).length) {
    out.push("| Capability | Calls | Input tok | Output tok | Cache read tok | USD | USD per 1k calls |", "|---|---|---|---|---|---|---|");
    for (const [cap, c] of Object.entries(run.cost.perCapability)) out.push(`| ${cap} | ${c.calls} | ${c.inputTokens} | ${c.outputTokens} | ${c.cacheReadTokens} | ${cell(c.usd)} | ${cell(c.usdPer1kCalls)} |`);
  }
  const errs = Object.entries(run.errors).filter(([, n]) => n > 0);
  if (errs.length) out.push("", "## Provider errors", "", ...errs.map(([c, n]) => `- ${c}: ${n}`));
  if (run.failures.length) {
    out.push("", `<details><summary>${run.failures.length} case miss(es)</summary>`, "", ...run.failures.map((f) => `- ${f}`), "", "</details>");
  }
  for (const [k, v] of Object.entries(run.details)) out.push("", `- ${k}: ${v}`);
  return out.join("\n") + "\n";
}
