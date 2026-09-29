import type { ModuleWorker } from "@cnote/core";
import { expireOverdueOffers, repairCascades, sweepStuckScoring } from "./leads";

export const worker: ModuleWorker = {
  name: "enquiry",
  handlers: {},
  jobs: [
    { name: "enquiry.expire-offers", everyMs: 60_000, run: async () => void (await expireOverdueOffers()) },
    { name: "enquiry.repair", everyMs: 60_000, run: async () => { await repairCascades(); await sweepStuckScoring(); } },
  ],
};
