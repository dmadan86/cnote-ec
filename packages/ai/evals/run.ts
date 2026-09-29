import { runEvals } from "./harness";

const report = await runEvals();
console.log(`AI evals (provider: ${process.env.AI_PROVIDER ?? "heuristic"})`);
for (const m of report.metrics) console.log(`  ${m.pass ? "PASS" : "FAIL"}  ${m.name.padEnd(28)} ${m.value.toFixed(3)}  (>= ${m.threshold})`);
for (const [k, v] of Object.entries(report.details)) console.log(`  info  ${k.padEnd(28)} ${v}`);
if (report.failures.length) {
  console.log(`\n${report.failures.length} case miss(es):`);
  for (const f of report.failures) console.log("  - " + f);
}
process.exit(report.pass ? 0 : 1);
