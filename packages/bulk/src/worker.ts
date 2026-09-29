import { queueConsumer, type ModuleWorker } from "@cnote/core";
import { purgeExpiredJobs, runExportJob, runImportJob, validateImportJob } from "./jobs";

const HOUR_MS = 3_600_000;

/** Register in apps/worker like the other module workers. */
export const worker: ModuleWorker = {
  name: "bulk",
  handlers: {},
  queues: [
    queueConsumer("bulk.validate", async (msg) => validateImportJob(msg.payload.jobId), 1),
    queueConsumer("bulk.import", async (msg) => runImportJob(msg.payload.jobId, msg), 2),
    queueConsumer("bulk.export", async (msg) => runExportJob(msg.payload.jobId, msg), 1),
  ],
  jobs: [{ name: "bulk.purge-expired", everyMs: HOUR_MS, run: async () => void (await purgeExpiredJobs()) }],
};
