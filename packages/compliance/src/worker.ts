import type { ModuleWorker } from "@cnote/core";
import { sweepGrievanceSla } from "./grievance";
import { runDueRetention } from "./retention";

/** Hourly ticks: staggered daily retention (see runDueRetention) and the grievance SLA sweep. Register in apps/worker. */
export const worker: ModuleWorker = {
  name: "compliance",
  handlers: {},
  jobs: [
    { name: "retention", everyMs: 3_600_000, run: async () => void (await runDueRetention()) },
    { name: "grievance-sla", everyMs: 3_600_000, run: async () => void (await sweepGrievanceSla()) },
  ],
};
