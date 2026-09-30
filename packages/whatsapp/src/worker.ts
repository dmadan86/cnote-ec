import { queueConsumer, type ModuleWorker } from "@cnote/core";
import { handleInboundJob } from "./inbound";
import { purgeWhatsAppMessages } from "./retention";
import { DAY_MS } from "./config";

/** Register in apps/worker: consumes "whatsapp.inbound" and purges message bodies older than 30 days daily. */
export const worker: ModuleWorker = {
  name: "whatsapp",
  handlers: {},
  queues: [queueConsumer("whatsapp.inbound", (msg) => handleInboundJob(msg), 2)],
  jobs: [
    {
      name: "whatsapp.purge-messages",
      everyMs: DAY_MS,
      run: async () => {
        const n = await purgeWhatsAppMessages();
        if (n) console.log(`[whatsapp] scrubbed ${n} message bodies past retention`);
      },
    },
  ],
};
