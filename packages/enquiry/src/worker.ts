import { queueConsumer, type ModuleWorker } from "@cnote/core";
import { markOrderEscrowed } from "./orders";
import { expireOverdueOffers, repairCascades, sweepStuckScoring } from "./leads";
import { sendPayableReminders } from "./supplier-invoices";
import { sweepRateContracts } from "./rate-contracts";
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
    // MSME 43B(h) payment reminders at T-7, T-1 and overdue (docs/design/purchase-orders.md); once per stage per invoice.
    { name: "enquiry.payable-reminders", everyMs: 60 * 60_000, run: async () => void (await sendPayableReminders()) },
    // rate contracts: expire ended contracts and remind both sides 30 / 7 days before the end; never renews anything (docs/design/rate-contracts.md)
    { name: "enquiry.rate-contract-sweep", everyMs: 60 * 60_000, run: async () => void (await sweepRateContracts()) },
  ],
  queues: [queueConsumer(REACHABILITY_DISPATCH_TOPIC, async (m) => handleDispatchJob(m.payload.checkId))],
};
