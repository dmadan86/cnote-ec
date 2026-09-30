// pnpm --filter @cnote/analytics backfill                      # drain every projection to the head of the log
// pnpm --filter @cnote/analytics backfill --reset funnel gmv   # wipe those (+ dependents) and replay from event 0
// pnpm --filter @cnote/analytics backfill --status             # checkpoints + lag
import { pathToFileURL } from "node:url";
import { backfill, getProjectionStatus } from "./runner";

export async function run(argv: string[], log: (line: string) => void = console.log): Promise<void> {
  if (argv.includes("--status")) {
    for (const s of await getProjectionStatus()) log(`${s.projection} v${s.version} at ${s.lastEventId} (lag ${s.lagEvents}, applied ${s.eventsApplied})`);
    return;
  }
  const reset = argv.includes("--reset");
  const projections = argv.filter((a) => !a.startsWith("--"));
  for (const r of await backfill({ projections, reset })) log(`${r.projection}: applied ${r.applied} events, at ${r.lastEventId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
