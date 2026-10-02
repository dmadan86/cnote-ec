import { expect, it } from "vitest";
import { runEvals } from "../evals/harness";
import { heuristicProviders } from "../src";

// CI gate (ADR-008): a change that degrades the heuristic provider below its thresholds fails here.
it("heuristic provider meets its eval thresholds", async () => {
  const report = await runEvals(heuristicProviders, new Date(), undefined, { skipTags: ["llm-only"] });
  expect(report.failures.length, report.failures.join("\n")).toBeLessThan(10);
  for (const m of report.metrics) expect(m.value, `${m.name}: ${report.failures.join(" | ")}`).toBeGreaterThanOrEqual(m.threshold);
});
