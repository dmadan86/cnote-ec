import { queueConsumer, redis, type ModuleWorker } from "@cnote/core";
import { flushTraffic } from "./metering";
import { processDomainCheck, recheckLiveDomains, sweepStalledDomains, VERIFY_TOPIC } from "./lifecycle";

export const worker: ModuleWorker = {
  name: "domains",
  handlers: {},
  queues: [queueConsumer(VERIFY_TOPIC, async (msg) => void (await processDomainCheck(msg.payload.domainId, msg.payload.gen)), 2)],
  jobs: [
    {
      name: "domains.flush-traffic",
      everyMs: 5 * 60_000,
      run: async () => {
        // one flusher at a time across worker replicas; flush is idempotent anyway
        if ((await redis.set("sfm:flush:lock", "1", "EX", 240, "NX")) !== "OK") return;
        await flushTraffic();
      },
    },
    { name: "domains.recheck-live", everyMs: 6 * 3600_000, run: async () => void (await recheckLiveDomains()) },
    { name: "domains.sweep-stalled", everyMs: 60 * 60_000, run: async () => void (await sweepStalledDomains()) },
  ],
};
