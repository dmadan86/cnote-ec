import { queueConsumer, type ModuleWorker } from "@cnote/core";
import { advanceNegotiation, expireMandatesAndNegotiations, runDueMandatesJob, sweepJob } from "./jobs";
import { finalise } from "./negotiation";
import { ADVANCE_TOPIC, FINALISE_TOPIC } from "./queue";
import { isA2aEnabled } from "./common";

/**
 * No event handlers: the negotiation tables are the source of truth and the module's own jobs drive it. Scheduled jobs:
 * a2a.run_mandates (recurring buyer mandates), a2a.sweep (unstick idle negotiations), a2a.expire (mandates + negotiations).
 * Queue consumers: a2a.advance (let internal agents move) and a2a.finalise (record the Quote/Order after both confirm).
 */
export const worker: ModuleWorker = {
  name: "a2a",
  handlers: {},
  jobs: [
    { name: "a2a.run_mandates", everyMs: 60_000, run: runDueMandatesJob },
    { name: "a2a.sweep", everyMs: 60_000, run: sweepJob },
    { name: "a2a.expire", everyMs: 5 * 60_000, run: expireMandatesAndNegotiations },
  ],
  queues: [
    queueConsumer(ADVANCE_TOPIC, async (m) => void (await advanceNegotiation(m.payload.negotiationId))),
    queueConsumer(FINALISE_TOPIC, async (m) => {
      if (isA2aEnabled()) await finalise(m.payload.negotiationId);
    }),
  ],
};
