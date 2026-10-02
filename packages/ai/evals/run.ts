// pnpm --filter @cnote/ai eval [--provider heuristic|anthropic] [--out dir] [--update-baseline]
// Runs every golden set against one provider, writes <out>/<provider>.json + .md, compares with
// evals/baseline/<provider>.json and exits 1 on a hard-floor breach or a regression beyond tolerance (ADR-008).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createAnthropicClient } from "../src/anthropic";
import { anthropicProviders, heuristicProviders } from "../src/registry";
import extractionSet from "./data/extraction.json";
import intentSet from "./data/intent.json";
import moderationSet from "./data/moderation.json";
import visionSet from "./data/vision.json";
import { runEvals } from "./harness";
import { Meter } from "./metering";
import { buildRun, compareToBaseline, renderMarkdown, type EvalRun } from "./metrics";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const provider = arg("provider", process.env.AI_PROVIDER === "anthropic" ? "anthropic" : "heuristic")!;
if (provider !== "heuristic" && provider !== "anthropic") { console.error(`Unknown provider "${provider}" (heuristic | anthropic)`); process.exit(2); }
if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY is required for --provider anthropic"); process.exit(2); }
process.env.AI_PROVIDER = provider; // the harness gates its live-only vision checks on this

const outDir = arg("out", new URL("./reports/", import.meta.url).pathname)!;
const baselinePath = arg("baseline", new URL(`./baseline/${provider}.json`, import.meta.url).pathname)!;

const meter = new Meter();
const providers = provider === "anthropic" ? anthropicProviders(meter.wrap(createAnthropicClient()), false) : heuristicProviders;

// Wall-clock per provider call, attributed to the capability the harness announces.
const latencies: Record<string, number[]> = {};
let current: string | null = null;
let startedAt = 0;
const onCapability = (cap: string | null) => {
  if (cap) { current = cap; startedAt = performance.now(); }
  else if (current) { (latencies[current] ??= []).push(performance.now() - startedAt); current = null; }
  meter.current = cap;
};

const skipTags = provider === "heuristic" ? ["llm-only"] : [];
const report = await runEvals(providers, new Date(), undefined, { skipTags, onCapability });
const run = buildRun({ provider, report, latencies, usage: meter.usage, models: [...meter.models].sort() });
if (meter.unpriced.size) run.details.unpricedModels = [...meter.unpriced].join(", ");

const baseline: EvalRun | null = existsSync(baselinePath) ? (JSON.parse(readFileSync(baselinePath, "utf8")) as EvalRun) : null;
const cases = {
  intent: intentSet.length,
  extract: extractionSet.length,
  moderate: (moderationSet as { tags?: string[] }[]).filter((c) => !c.tags?.some((t) => skipTags.includes(t))).length,
  extract_image: visionSet.length,
};
const cmp = compareToBaseline(run, baseline, cases);
const md = renderMarkdown(run, cmp, baseline);

mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/${provider}.json`, JSON.stringify(run, null, 2) + "\n");
writeFileSync(`${outDir}/${provider}.md`, md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
console.log(md);

if (flag("update-baseline")) {
  if (cmp.findings.some((f) => f.kind === "floor")) console.error("Refusing to write a baseline that breaches a hard floor.");
  else {
    mkdirSync(new URL("./baseline/", import.meta.url).pathname, { recursive: true });
    writeFileSync(baselinePath, JSON.stringify({ ...run, tolerance: baseline?.tolerance }, null, 2) + "\n");
    console.log(`Baseline written: ${baselinePath}`);
  }
}
process.exit(cmp.findings.length ? 1 : 0);
