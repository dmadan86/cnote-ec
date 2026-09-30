import { queueConsumer, type ModuleWorker } from "@cnote/core";
import { publishAllCatalogs } from "./catalog";
import { isEnabled } from "./config";
import { purgeOldMessages } from "./admin";
import { onOrderFulfilmentUpdated, onOrderStatusChanged } from "./fulfilment";
import { escalateOverdueIssues, onDisputeEscalated, onDisputeResolved, purgeIssuePayloads } from "./igm";
import { deliverCallback } from "./outbound";
import { processInbound } from "./processor";
import "./types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** ADR-017. Every consumer/job is a no-op while ONDC_ENABLED is off. */
export const worker: ModuleWorker = {
  name: "ondc",
  handlers: {
    // ADR-021: platform order progress -> unsolicited on_status; dispute progress -> on_issue_status (all idempotent, flag/kill-switch aware)
    OrderStatusChanged: async (e) => void (await onOrderStatusChanged(e.payload)),
    OrderFulfilmentUpdated: async (e) => void (await onOrderFulfilmentUpdated(e.payload)),
    DisputeEscalated: async (e) => void (await onDisputeEscalated(e.payload)),
    DisputeResolved: async (e) => void (await onDisputeResolved(e.payload)),
  },
  queues: [
    queueConsumer("ondc.inbound", async (msg) => void (await processInbound(msg.payload.messageId)), 2),
    queueConsumer("ondc.callback", async (msg) => void (await deliverCallback(msg.payload.messageId)), 2),
  ],
  jobs: [
    { name: "ondc.publish-catalogs", everyMs: HOUR, run: async () => void (await publishAllCatalogs()) },
    { name: "ondc.purge-messages", everyMs: DAY, run: async () => void (isEnabled() ? (await purgeOldMessages(), await purgeIssuePayloads(new Date(Date.now() - 90 * DAY))) : 0) },
    { name: "ondc.igm-ttl", everyMs: 10 * 60_000, run: async () => void (await escalateOverdueIssues()) },
  ],
};
