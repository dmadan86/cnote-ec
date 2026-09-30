import { queueConsumer, type ModuleWorker } from "@cnote/core";
import { collectEvidence, runBrief } from "./brief";
import { BRIEF_TOPIC, COLLECT_TOPIC } from "./jobs";
import { EVIDENCE_RETENTION_DAYS, disputesEnabled, DAY_MS } from "./config";
import { purgeResolvedDisputeEvidence } from "./retention";
import { runAdvanceJob } from "./sla";

export const worker: ModuleWorker = {
  name: "disputes",
  handlers: {},
  jobs: [
    { name: "disputes.advance", everyMs: 5 * 60_000, run: runAdvanceJob },
    {
      name: "disputes.purge-evidence",
      everyMs: DAY_MS,
      run: async () => {
        const n = await purgeResolvedDisputeEvidence(new Date(Date.now() - EVIDENCE_RETENTION_DAYS * DAY_MS));
        if (n) console.log(`[disputes] purged evidence of ${n} closed disputes`);
      },
    },
  ],
  queues: [
    queueConsumer(COLLECT_TOPIC, async (m) => { if (disputesEnabled()) await collectEvidence(m.payload.disputeId); }),
    queueConsumer(BRIEF_TOPIC, async (m) => { if (disputesEnabled()) await runBrief(m.payload.disputeId); }),
  ],
};
