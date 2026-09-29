// Background process: relays the outbox to Redis Streams, runs each module's event handlers
// (one consumer group per module) and scheduled jobs. Modules plug in via their `worker` export.
import { worker as ai } from "@cnote/ai";
import { worker as billing } from "@cnote/billing";
import { worker as catalogue } from "@cnote/catalogue";
import { consumeOnce, relayOutbox, type ModuleWorker } from "@cnote/core";
import { worker as enquiry } from "@cnote/enquiry";
import { worker as identity } from "@cnote/identity";
import { hostname } from "node:os";

const modules: ModuleWorker[] = [identity, catalogue, billing, enquiry, ai];
const consumer = `${hostname()}-${process.pid}`;
let running = true;

async function loop(name: string, fn: () => Promise<unknown>, idleMs: number) {
  while (running) {
    try {
      await fn();
    } catch (err) {
      console.error(`[worker] ${name} failed`, err);
    }
    await new Promise((r) => setTimeout(r, idleMs));
  }
}

console.log(`[worker] starting ${consumer}: ${modules.map((m) => m.name).join(", ")}`);
void loop("relay", () => relayOutbox(), 250);
for (const m of modules) {
  if (Object.keys(m.handlers).length) void loop(`consume:${m.name}`, () => consumeOnce(m.name, consumer, m.handlers), 0);
  for (const job of m.jobs) void loop(`job:${m.name}:${job.name}`, job.run, job.everyMs);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    running = false;
    console.log(`[worker] ${sig}, stopping`);
    setTimeout(() => process.exit(0), 1500);
  });
}
