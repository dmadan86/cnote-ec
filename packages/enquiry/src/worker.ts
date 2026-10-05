import { queueConsumer, type ModuleWorker } from "@cnote/core";
import { closeUnapprovedEnquiry, resumeApprovedEnquiry } from "./approvals";
import { resumeApprovedQuote } from "./comparison";
import { markOrderEscrowed } from "./orders";
import { expireOverdueOffers, repairCascades, sweepStuckScoring } from "./leads";
import { REACHABILITY_DISPATCH_TOPIC, handleDispatchJob, resolveReachabilityChecks } from "./reachability";

export const worker: ModuleWorker = {
  name: "enquiry",
  handlers: {
    // ADR-012: settlement flips to "escrow" once the partner confirms funding.
    EscrowFunded: async (e) => void (await markOrderEscrowed(e.payload.orderId)),
    // docs/design/buyer-approvals.md: held RFQs and quote acceptances resume (or close) when their approval chain finishes.
    ApprovalApproved: async (e) => {
      if (e.payload.subjectType === "enquiry") await resumeApprovedEnquiry(e.payload);
      else if (e.payload.subjectType === "quote") await resumeApprovedQuote(e.payload);
    },
    ApprovalRejected: async (e) => {
      if (e.payload.subjectType === "enquiry") await closeUnapprovedEnquiry(e.payload);
    },
  },
  jobs: [
    { name: "enquiry.expire-offers", everyMs: 60_000, run: async () => void (await expireOverdueOffers()) },
    { name: "enquiry.repair", everyMs: 60_000, run: async () => { await repairCascades(); await sweepStuckScoring(); } },
    { name: "enquiry.resolve-reachability", everyMs: 10 * 60_000, run: async () => void (await resolveReachabilityChecks()) },
  ],
  queues: [queueConsumer(REACHABILITY_DISPATCH_TOPIC, async (m) => handleDispatchJob(m.payload.checkId))],
};
