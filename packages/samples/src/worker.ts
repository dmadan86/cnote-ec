import type { ModuleWorker } from "@cnote/core";
import { SAMPLE_RETENTION_DAYS, DAY_MS } from "./config";
import { erasePersonSamples, purgeClosedSamplePersonalData } from "./retention";
import { runExpiryJob } from "./sla";

export const worker: ModuleWorker = {
  name: "samples",
  handlers: {
    DataErasureRequested: async (event) => {
      await erasePersonSamples(event.payload.personId);
    },
  },
  jobs: [
    // Seller SLA: unanswered requests expire after the response window (default 48h). Every 15 minutes is well inside it.
    { name: "samples.expire-overdue", everyMs: 15 * 60_000, run: runExpiryJob },
    {
      name: "samples.purge-personal-data",
      everyMs: DAY_MS,
      run: async () => {
        const n = await purgeClosedSamplePersonalData(new Date(Date.now() - SAMPLE_RETENTION_DAYS * DAY_MS));
        if (n) console.log(`[samples] purged personal data of ${n} closed request(s)`);
      },
    },
  ],
};
