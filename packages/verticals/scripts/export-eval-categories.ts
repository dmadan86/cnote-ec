// Regenerates packages/ai/evals/proposed/<playbook>/categories.json from the playbook data:
//   pnpm --filter @cnote/verticals exec tsx scripts/export-eval-categories.ts [playbook-key]
// A test fails when the committed file drifts from the playbook.
import { writeFileSync } from "node:fs";
import { getPlaybook, playbookToEvalCategories } from "../src/playbook/index";

const key = process.argv[2] ?? "packaging-bengaluru";
const pb = getPlaybook(key);
if (!pb) throw new Error(`unknown playbook ${key}`);
const rows = playbookToEvalCategories(pb).map((c) => JSON.stringify(c)).join(",\n  ");
const path = new URL(`../../ai/evals/proposed/${key}/categories.json`, import.meta.url).pathname;
writeFileSync(path, `[\n  ${rows}\n]\n`);
console.log(`wrote ${path}`);
process.exit(0); // imported modules may hold Redis/DB handles open
