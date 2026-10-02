import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { EvalReport } from "../evals/harness";
import { runEvals } from "../evals/harness";
import { Meter, priceCall } from "../evals/metering";
import { DEFAULT_TOLERANCE, buildRun, calibrate, compareToBaseline, percentile, renderMarkdown, type EvalRun } from "../evals/metrics";
import { PROMPTS, computeManifest, constString, diffManifest, unbumped, versionOf, type Manifest } from "../evals/prompt-manifest";
import { renderShadowMarkdown } from "../evals/shadow";
import moderationSet from "../evals/data/moderation.json";
import { anthropicProviders, heuristicProviders } from "../src";
import type { MessagesClient } from "../src/anthropic";

const root = new URL("..", import.meta.url);
const read = (f: string) => readFileSync(new URL(f, root), "utf8");

describe("calibration maths", () => {
  it("handles empty input", () => {
    expect(calibrate([])).toMatchObject({ n: 0, reviewRate: 0, accuracy: 0, accuracyAutoAccepted: null, autoAcceptErrorRate: null, ece: 0 });
  });
  it("splits auto-accepted from human-routed", () => {
    const c = calibrate([
      { id: "a", correct: true, confidence: 0.95, humanRouted: false },
      { id: "b", correct: false, confidence: 0.9, humanRouted: false },
      { id: "c", correct: false, confidence: 0.3, humanRouted: true },
      { id: "d", correct: true, confidence: 0.4, humanRouted: true },
    ]);
    expect(c).toMatchObject({ n: 4, reviewRate: 0.5, accuracy: 0.5, accuracyAutoAccepted: 0.5, accuracyHumanRouted: 0.5, autoAcceptErrorRate: 0.5 });
    expect(c.ece).toBeGreaterThan(0);
  });
  it("a perfectly calibrated set has ece 0 and clamps confidence 1 into the top bin", () => {
    expect(calibrate([{ id: "a", correct: true, confidence: 1, humanRouted: false }])).toMatchObject({ ece: 0, accuracyHumanRouted: null });
  });
  it("percentile is nearest-rank", () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
  });
});

const emptyReport = (over: Partial<EvalReport> = {}): EvalReport => ({
  metrics: [{ name: "moderationBlockRecall", value: 0.95, threshold: 0.9, pass: true }, { name: "intentBandAccuracy", value: 0.9, threshold: 0.85, pass: true }],
  failures: ["moderate/x: missed"], pass: true, details: { note: "n" },
  samples: { intent: [{ id: "i", correct: true, confidence: 0.8, humanRouted: false }], extract: [], moderate: [{ id: "m", correct: true, confidence: 0.9, humanRouted: false }] },
  errors: { intent: 0, extract: 0, moderate: 1, extract_image: 0 },
  ...over,
});
const mkRun = (provider = "anthropic", over: Partial<Parameters<typeof buildRun>[0]> = {}): EvalRun =>
  buildRun({
    provider, report: emptyReport(), latencies: { moderate: [100, 200, 300], intent: [] },
    usage: { moderate: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 2, usd: 0.0025 } },
    models: ["claude-haiku-4-5"], now: new Date("2026-01-01T00:00:00Z"), ...over,
  });

describe("buildRun", () => {
  it("assembles metrics, calibration (non-empty only), latency, and cost per 1k calls", () => {
    const run = mkRun();
    expect(run.metrics.moderationBlockRecall).toEqual({ value: 0.95, threshold: 0.9, pass: true });
    expect(Object.keys(run.calibration)).toEqual(["intent", "moderate"]);
    expect(run.latencyMs).toEqual({ moderate: { n: 3, p50: 200, p95: 300 } });
    expect(run.cost.totalUsd).toBe(0.0025);
    expect(run.cost.perCapability.moderate!.usdPer1kCalls).toBe(1.25);
  });
  it("an unpriced model makes the total unknown", () => {
    const run = mkRun("anthropic", { usage: { moderate: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0, usd: null } } });
    expect(run.cost.totalUsd).toBeNull();
    expect(run.cost.perCapability.moderate!.usdPer1kCalls).toBeNull();
  });
});

describe("compareToBaseline", () => {
  const cases = { intent: 27, moderate: 100 };
  const base = () => mkRun("anthropic");
  const withMetric = (r: EvalRun, name: string, value: number): EvalRun => ({ ...r, metrics: { ...r.metrics, [name]: { ...r.metrics[name]!, value } } });

  it("passes when nothing moved, and notes a missing baseline instead of failing", () => {
    expect(compareToBaseline(mkRun(), base(), cases).findings).toEqual([]);
    const none = compareToBaseline(mkRun(), null, cases);
    expect(none.findings).toEqual([]);
    expect(none.notes[0]).toMatch(/No committed baseline/);
  });
  it("hard floors fail even without a baseline", () => {
    const run = withMetric(mkRun(), "moderationBlockRecall", 0.5);
    run.metrics.moderationBlockRecall!.pass = false;
    expect(compareToBaseline(run, null).findings).toEqual([expect.objectContaining({ kind: "floor", key: "moderationBlockRecall" })]);
  });
  it("flags a quality drop beyond tolerance, but not within it", () => {
    expect(compareToBaseline(withMetric(mkRun(), "intentBandAccuracy", 0.9 - DEFAULT_TOLERANCE.quality + 0.001), base()).findings).toEqual([]);
    const f = compareToBaseline(withMetric(mkRun(), "intentBandAccuracy", 0.8), base()).findings;
    expect(f).toEqual([expect.objectContaining({ kind: "regression", key: "intentBandAccuracy" })]);
  });
  it("per-metric tolerance in the baseline overrides the default", () => {
    const b = { ...base(), tolerance: { intentBandAccuracy: 0.2 } };
    expect(compareToBaseline(withMetric(mkRun(), "intentBandAccuracy", 0.75), b).findings).toEqual([]);
  });
  it("notes metrics the baseline has but this run did not measure", () => {
    const run = mkRun();
    delete run.metrics.intentBandAccuracy;
    delete run.calibration.intent;
    const n = compareToBaseline(run, base()).notes;
    expect(n.join("\n")).toMatch(/intentBandAccuracy.*not measured/);
    expect(n.join("\n")).toMatch(/calibration\/intent/);
  });
  it("flags wrong answers that skip human review, and a flooded review queue", () => {
    const run = mkRun();
    run.calibration.moderate = { ...run.calibration.moderate!, autoAcceptErrorRate: 0.3, reviewRate: 0.9 };
    const keys = compareToBaseline(run, base()).findings.map((f) => f.key);
    expect(keys).toContain("calibration.moderate.autoAcceptErrorRate");
    expect(keys).toContain("calibration.moderate.reviewRate");
  });
  it("ignores calibration when auto-accept rates are unknown", () => {
    const run = mkRun();
    run.calibration.moderate = { ...run.calibration.moderate!, autoAcceptErrorRate: null };
    expect(compareToBaseline(run, base()).findings).toEqual([]);
  });
  it("flags provider errors rising beyond tolerance, scaled by case count", () => {
    const run = mkRun("anthropic", { report: emptyReport({ errors: { intent: 0, extract: 0, moderate: 20, extract_image: 0 } }) });
    expect(compareToBaseline(run, base(), cases).findings.map((f) => f.key)).toEqual(["errors.moderate"]);
    expect(compareToBaseline(run, base(), {}).findings).toEqual([]); // unknown case counts: cannot compute a rate
  });
  it("flags p95 latency and cost growth for real providers only", () => {
    const slow = mkRun("anthropic", { latencies: { moderate: [5000, 6000, 7000] }, usage: { moderate: { inputTokens: 9, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 2, usd: 0.01 } } });
    const keys = compareToBaseline(slow, base()).findings.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["latency.moderate", "cost.moderate"]));
    const heuristicBase = { ...base(), provider: "heuristic" };
    const c = compareToBaseline(slow, heuristicBase);
    expect(c.findings).toEqual([]);
    expect(c.notes.join()).toMatch(/not compared for the heuristic/);
  });
  it("skips latency/cost lines missing on either side or priced at zero/unknown", () => {
    const b = base();
    b.cost.perCapability.moderate!.usd = 0;
    b.cost.perCapability.intent = { ...b.cost.perCapability.moderate!, usd: null };
    const run = mkRun("anthropic", { latencies: { moderate: [100], extract: [999999] } });
    run.cost.perCapability.intent = { ...run.cost.perCapability.moderate!, usd: 5 };
    b.latencyMs.extract = { n: 1, p50: 1, p95: 1 };
    delete run.cost.perCapability.moderate;
    expect(compareToBaseline(run, b).findings.map((f) => f.key)).toEqual(["latency.extract"]);
  });
});

describe("renderMarkdown", () => {
  it("shows findings, baselines, calibration, latency, cost, errors and misses", () => {
    const run = mkRun();
    const cmp = compareToBaseline({ ...run, metrics: { ...run.metrics, intentBandAccuracy: { value: 0.1, threshold: 0.85, pass: false } } }, run);
    const md = renderMarkdown(run, cmp, run);
    expect(md).toMatch(/AI eval report: anthropic/);
    expect(md).toMatch(/\*\*FAILED\*\*/);
    expect(md).toMatch(/Provider errors/);
    expect(md).toMatch(/1 case miss/);
    expect(md).toMatch(/USD per 1k calls/);
    expect(md).toMatch(/\| moderationBlockRecall \| 0.95 \| 0.9 \| 0.95 \| ok \|/);
  });
  it("renders a clean pass with no baseline, offline models and unknown cost", () => {
    const run = mkRun("heuristic", { models: [], usage: {}, report: emptyReport({ errors: {}, failures: [], details: {} }) });
    const md = renderMarkdown(run, compareToBaseline(run, null), null);
    expect(md).toMatch(/\*\*PASSED\*\*/);
    expect(md).toMatch(/n\/a \(offline provider\)/);
    expect(md).toMatch(/\| n\/a \| ok \|/);
    const unknown = renderMarkdown({ ...run, cost: { totalUsd: null, perCapability: {} } }, { baseline: null, findings: [], notes: [] }, null);
    expect(unknown).toMatch(/n\/a \(unpriced model\)/);
  });
});

describe("metering", () => {
  it("prices list rates with cache discounts, null for unknown models", () => {
    expect(priceCall("claude-sonnet-5-5", { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(12);
    expect(priceCall("claude-sonnet-5-5", { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 })).toBeCloseTo(0.2 + 2.5);
    expect(priceCall("claude-mystery", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });
  it("attributes calls to the announced capability and counts models", async () => {
    const meter = new Meter();
    const client = meter.wrap({ messages: { create: async () => ({ usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50 }, content: [] }) } } as unknown as MessagesClient);
    meter.current = "moderate";
    await client.messages.create({ model: "claude-haiku-4-5" } as never);
    meter.current = null;
    await client.messages.create({ model: "claude-mystery" } as never);
    expect(meter.usage.moderate).toMatchObject({ calls: 1, inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 });
    expect(meter.usage.moderate!.usd).toBeGreaterThan(0);
    expect(meter.usage.other!.usd).toBeNull();
    expect([...meter.models].sort()).toEqual(["claude-haiku-4-5", "claude-mystery"]);
    expect([...meter.unpriced]).toEqual(["claude-mystery"]);
    // a priced call after an unpriced one in the same bucket keeps the bucket unknown
    await client.messages.create({ model: "claude-haiku-4-5" } as never);
    expect(meter.usage.other!.usd).toBeNull();
    meter.record("claude-haiku-4-5", undefined);
  });
});

describe("harness against a failing real-provider stand-in", () => {
  it("counts thrown errors and silent fallbacks as wrong answers, never as skipped cases", async () => {
    const boom = { create: async () => { throw new Error("529 overloaded"); } };
    const providers = anthropicProviders({ messages: boom } as unknown as MessagesClient, false);
    const caps: (string | null)[] = [];
    const report = await runEvals(providers, new Date(), undefined, { onCapability: (c) => caps.push(c) });
    expect(report.pass).toBe(false);
    expect(report.errors.intent).toBe(27);
    expect(report.errors.moderate).toBeGreaterThan(90);
    expect(report.errors.extract_image).toBeGreaterThan(0);
    expect(report.metrics.find((m) => m.name === "moderationBlockRecall")!.value).toBe(0);
    expect(report.samples.moderate!.every((s) => !s.correct && s.humanRouted)).toBe(true);
    expect(caps.filter((c) => c === "moderate")).toHaveLength(report.errors.moderate!);

    const fallbackReport = await runEvals(anthropicProviders(({ messages: boom }) as unknown as MessagesClient, true), new Date());
    expect(fallbackReport.errors.intent).toBe(27); // heuristic-fallback answers do not count as the model's
  });
});

describe("prompt manifest", () => {
  it("parses string constants and versions", () => {
    const src = 'const A = `hello ${B} \\` world`;\nexport const B = "bee";\nconst V = { x: "x-v1", y: "y-v2" } as const;\nexport const W = "w-v3";';
    expect(constString(src, "A")).toBe("hello ${B} \\` world");
    expect(constString(src, "B")).toBe("bee");
    expect(constString(src, "MISSING")).toBeNull();
    expect(constString("const C = `unterminated", "C")).toBeNull();
    expect(versionOf(src, "V.y")).toBe("y-v2");
    expect(versionOf(src, "V.z")).toBeNull();
    expect(versionOf(src, "W")).toBe("w-v3");
  });

  it("the committed manifest matches the code (change a prompt or model: bump its version, then eval:manifest --write)", () => {
    const committed = JSON.parse(read("prompts.manifest.json")) as Manifest;
    expect(diffManifest(computeManifest(read), committed)).toEqual([]);
  });

  it("every system prompt const in src/ is registered in the manifest", () => {
    const registered = new Set(PROMPTS.map((p) => `src/${p.file.replace("src/", "")}:${p.const}`));
    for (const f of readdirSync(new URL("src/", root)).filter((n) => n.endsWith(".ts"))) {
      for (const m of read(`src/${f}`).matchAll(/(?:^|\n)(?:export\s+)?const\s+((?:[A-Z]+_)?SYSTEM)\s*=\s*`/g)) {
        expect(registered.has(`src/${f}:${m[1]}`), `${f} ${m[1]} is not in PROMPTS (evals/prompt-manifest.ts)`).toBe(true);
      }
    }
  });

  it("detects unbumped text changes, stale manifests, new/removed prompts and model changes", () => {
    const files: Record<string, string> = {};
    for (const f of new Set([...PROMPTS.map((p) => p.file), "src/registry.ts", "src/remote.ts"])) files[f] = read(f);
    const base = computeManifest((f) => files[f] ?? read(f));
    const edited = (f: string, from: string, to: string) => computeManifest((x) => (x === f ? files[f]!.replace(from, to) : files[x] ?? read(x)));

    expect(diffManifest(base, null)[0]).toMatch(/missing/);
    expect(unbumped(base, null)).toEqual([]);

    const text = edited("src/anthropic.ts", "You score buyer purchase intent", "You rate buyer purchase intent");
    expect(diffManifest(text, base)[0]).toMatch(/version is still "intent-v1"/);
    expect(unbumped(text, base)).toEqual(["intent"]);

    const bumped = edited("src/anthropic.ts", 'intent: "intent-v1"', 'intent: "intent-v2"');
    expect(diffManifest(bumped, base)[0]).toMatch(/intent-v1 -> intent-v2/);
    expect(unbumped(bumped, base)).toEqual([]);

    const model = edited("src/anthropic.ts", "claude-haiku-4-5", "claude-haiku-9-9");
    expect(diffManifest(model, base)[0]).toMatch(/model ids changed \(added: claude-haiku-9-9; removed: claude-haiku-4-5\)/);

    const extra: Manifest = { ...base, prompts: [...base.prompts, { id: "ghost", version: "g", sha256: "x" }] };
    expect(diffManifest(base, extra)[0]).toMatch(/"ghost" is in the manifest but no longer/);
    expect(diffManifest(base, { ...base, prompts: base.prompts.slice(1) })[0]).toMatch(/"intent" is new/);
    expect(diffManifest(edited("src/anthropic.ts", "model-less", "x"), base)).toEqual([]);
  });

  it("fails loudly when a registered prompt or version disappears", () => {
    expect(() => computeManifest((f) => (f === "src/anthropic.ts" ? "" : read(f)))).toThrow(/INTENT_SYSTEM not found/);
    expect(() => computeManifest((f) => (f === "src/anthropic.ts" ? read(f).replace("PROMPT_VERSIONS", "PV") : read(f)))).toThrow(/version PROMPT_VERSIONS.intent not found/);
  });
});

describe("golden set integrity", () => {
  type Mod = { id: string; text: string; verdict: string; flags?: string[]; tags?: string[] };
  const mod = moderationSet as Mod[];
  const CLASSES = ["pharma", "narcotics", "explosives", "weapons", "hazardous_chemicals", "wildlife", "counterfeit", "adult", "tobacco_alcohol"];
  const moderatePrompt = constString(read("src/anthropic.ts"), "MODERATE_SYSTEM")!;

  it("ids are unique, verdicts valid, and every block carries labels from the classifier's class list", () => {
    expect(new Set(mod.map((c) => c.id)).size).toBe(mod.length);
    for (const c of mod) {
      expect(["allow", "review", "block"]).toContain(c.verdict);
      if (c.verdict === "block") {
        expect(c.flags?.length, `${c.id} needs flags`).toBeGreaterThan(0);
        for (const f of c.flags!) expect(CLASSES, `${c.id}: unknown class ${f}`).toContain(f);
      } else expect(c.flags).toBeUndefined();
    }
  });
  it("the LLM prompt names every class the labels use", () => {
    for (const cls of CLASSES) expect(moderatePrompt).toContain(cls);
  });
  it("covers every prohibited class with at least two blocks, and the Hinglish / Devanagari / mixed / obfuscated slices", () => {
    for (const cls of CLASSES) expect(mod.filter((c) => c.verdict === "block" && c.flags?.includes(cls)).length, cls).toBeGreaterThanOrEqual(2);
    for (const tag of ["hinglish", "devanagari", "mixed", "obfuscated"]) expect(mod.filter((c) => c.tags?.includes(tag) && c.verdict === "block").length, tag).toBeGreaterThanOrEqual(2);
    expect(mod.filter((c) => c.verdict === "allow" && c.tags?.includes("hinglish")).length).toBeGreaterThanOrEqual(5);
    expect(mod.filter((c) => c.tags?.includes("llm-only")).length).toBeGreaterThanOrEqual(3);
    expect(mod.length).toBeGreaterThanOrEqual(100);
  });
  it("contains no phone numbers, emails or URLs (synthetic, PII-free)", () => {
    for (const c of mod) expect(c.text, c.id).not.toMatch(/\d{10}|@[a-z]+\.|https?:/i);
  });
  it("the heuristic provider skips llm-only cases and still passes every floor", async () => {
    const skipTags = ["llm-only"];
    const report = await runEvals(heuristicProviders, new Date(), undefined, { skipTags });
    expect(report.samples.moderate).toHaveLength(mod.filter((c) => !c.tags?.includes("llm-only")).length);
    expect(report.pass, report.failures.join("\n")).toBe(true);
  });
});

describe("shadow markdown", () => {
  it("renders an empty window and a table", () => {
    const since = new Date("2026-01-01T00:00:00Z");
    expect(renderShadowMarkdown([], since)).toMatch(/No shadow decisions/);
    const md = renderShadowMarkdown([{
      capability: "moderate", pairs: 10, shadowErrors: 1, agreement: 0.9, candidateMissedBlocks: 0, candidateExtraBlocks: 1,
      meanConfidence: { live: 0.9, shadow: 0.8 }, reviewRate: { live: 0.1, shadow: 0.2 }, latencyMs: { liveP50: 1, liveP95: 2, shadowP50: 3, shadowP95: 4 },
      models: { live: ["a"], shadow: ["b"] }, promptVersions: { live: ["v1"], shadow: ["v2"] },
    }], since);
    expect(md).toMatch(/\| moderate \| 10 \| 1 \| 0.9 \| 0 \| 1 \|/);
    expect(md).toMatch(/Promote a candidate only when/);
  });
});
