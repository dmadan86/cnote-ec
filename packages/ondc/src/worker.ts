import { queueConsumer, type ModuleWorker } from "@cnote/core";
import { publishAllCatalogs } from "./catalog";
import { isEnabled } from "./config";
import { purgeOldMessages } from "./admin";
import { deliverCallback } from "./outbound";
import { processInbound } from "./processor";
import "./types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** ADR-017. Every consumer/job is a no-op while ONDC_ENABLED is off. */
export const worker: ModuleWorker = {
  name: "ondc",
  handlers: {},
  queues: [
    queueConsumer("ondc.inbound", async (msg) => void (await processInbound(msg.payload.messageId)), 2),
    queueConsumer("ondc.callback", async (msg) => void (await deliverCallback(msg.payload.messageId)), 2),
  ],
  jobs: [
    { name: "ondc.publish-catalogs", everyMs: HOUR, run: async () => void (await publishAllCatalogs()) },
    { name: "ondc.purge-messages", everyMs: DAY, run: async () => void (isEnabled() ? await purgeOldMessages() : 0) },
  ],
};
