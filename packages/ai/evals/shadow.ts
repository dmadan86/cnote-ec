// pnpm --filter @cnote/ai eval:shadow [--hours 24] [--capability moderate] [--json]
// Compares shadow (AI_SHADOW_PROVIDER candidate) and live decisions from the AiDecision log. Read-only.
import { compareShadowDecisions, type ShadowComparison } from "../src/shadow-report";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

export function renderShadowMarkdown(rows: ShadowComparison[], since: Date): string {
  const out = [`# Shadow vs live decisions since ${since.toISOString()}`, ""];
  if (!rows.length) return out.concat("No shadow decisions in this window. Is AI_SHADOW_PROVIDER set on the worker/app?", "").join("\n");
  out.push("| Capability | Pairs | Errors | Agreement | Missed blocks | Extra blocks | Review rate live/shadow | Conf live/shadow | p95 ms live/shadow | Live model | Candidate model |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    out.push(`| ${r.capability} | ${r.pairs} | ${r.shadowErrors} | ${r.agreement ?? "n/a"} | ${r.candidateMissedBlocks} | ${r.candidateExtraBlocks} | ${r.reviewRate.live} / ${r.reviewRate.shadow} | ${r.meanConfidence.live} / ${r.meanConfidence.shadow} | ${r.latencyMs.liveP95} / ${r.latencyMs.shadowP95} | ${r.models.live.join(",")} (${r.promptVersions.live.join(",")}) | ${r.models.shadow.join(",")} (${r.promptVersions.shadow.join(",")}) |`);
  }
  out.push("", "Promote a candidate only when it has no missed blocks, agreement is high on the capabilities you care about, the review rate does not rise, and the golden-set eval (`pnpm --filter @cnote/ai eval`) passes on the candidate.", "");
  return out.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const since = new Date(Date.now() - Number(arg("hours", "24")) * 3_600_000);
  const capability = process.argv.includes("--capability") ? arg("capability", "") : undefined;
  const rows = await compareShadowDecisions({ since, ...(capability ? { capability } : {}) });
  console.log(process.argv.includes("--json") ? JSON.stringify(rows, null, 2) : renderShadowMarkdown(rows, since));
  process.exit(0);
}
