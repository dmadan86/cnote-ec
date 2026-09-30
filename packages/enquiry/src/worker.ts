import { queueConsumer, type ModuleWorker } from "@cnote/core";
import { markOrderEscrowed } from "./orders";
import { expireOverdueOffers, repairCascades, sweepStuckScoring } from "./leads";
import { REACHABILITY_DISPATCH_TOPIC, handleDispatchJob, resolveReachabilityChecks } from "./reachability";

export const worker: ModuleWorker = {
  name: "enquiry",
  handlers: {
    // ADR-012: settlement flips to "escrow" once the partner confirms funding.
    EscrowFunded: async (e) => void (await markOrderEscrowed(e.payload.orderId)),
  },
  jobs: [
    { name: "enquiry.expire-offers", everyMs: 60_000, run: async () => void (await expireOverdueOffers()) },
    { name: "enquiry.repair", everyMs: 60_000, run: async () => { await repairCascades(); await sweepStuckScoring(); } },
    { name: "enquiry.resolve-reachability", everyMs: 10 * 60_000, run: async () => void (await resolveReachabilityChecks()) },
  ],
  queues: [queueConsumer(REACHABILITY_DISPATCH_TOPIC, async (m) => handleDispatchJob(m.payload.checkId))],
};
