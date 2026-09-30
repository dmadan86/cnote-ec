// pnpm --filter @cnote/metrics backfill -- --from 2026-09-01 [--to 2026-09-29] [--metric id]
import { pathToFileURL } from "node:url";
import { backfill, type ComputeResult } from "./compute";
import { addDays, istDay } from "./time";

export async function run(argv: string[], log: (line: string) => void = console.log): Promise<ComputeResult[]> {
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const from = arg("from");
  if (!from) throw new Error("Usage: backfill --from YYYY-MM-DD [--to YYYY-MM-DD] [--metric id]");
  const to = arg("to") ?? addDays(istDay(), -1);
  const metric = arg("metric");
  const res = await backfill(from, to, metric ? { only: [metric] } : {});
  for (const r of res) log(`${r.day}: ${r.rows} rows, ${r.alerts} alerts`);
  return res;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
