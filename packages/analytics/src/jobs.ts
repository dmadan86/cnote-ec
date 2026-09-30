import type { ModuleWorker } from "@cnote/core";
import { runProjections } from "./runner";

/** How often a worker asks every projection to catch up. Rows are locked per projection, so extra workers just skip. */
export const PROJECT_EVERY_MS = 30_000;

export async function projectTick(): Promise<number> {
  const results = await runProjections();
  const applied = results.reduce((n, r) => n + r.applied, 0);
  if (applied) console.log(`[analytics] applied ${applied} events (${results.filter((r) => r.applied).map((r) => `${r.projection}:${r.applied}`).join(", ")})`);
  return applied;
}

export const worker: ModuleWorker = {
  name: "analytics",
  // Projections read the log by id range (not the Redis stream), so no event handlers: replays and gaps are handled by the checkpoint.
  handlers: {},
  jobs: [{ name: "analytics.project", everyMs: PROJECT_EVERY_MS, run: async () => void (await projectTick()) }],
};
