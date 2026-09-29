// Background process: relays the outbox to the event transport, runs each module's event handlers
// (observers; one consumer group per module), work-queue consumers (email, notifications, …) and
// scheduled jobs. Modules plug in via their `worker` export; transports come from QUEUE_DRIVER.
import * as Sentry from "@sentry/node";
import { sentryOptions } from "@cnote/observability";
import { worker as ai } from "@cnote/ai";
import { worker as billing } from "@cnote/billing";
import { worker as catalogue } from "@cnote/catalogue";
import { consumeOnce, getJobQueue, relayOutbox, type JobTopic, type ModuleWorker } from "@cnote/core";
import { worker as enquiry } from "@cnote/enquiry";
import { worker as identity } from "@cnote/identity";
import { worker as reviews } from "@cnote/reviews";
import { worker as wishlist } from "@cnote/wishlist";
import { hostname } from "node:os";

// No-op until SENTRY_DSN is set.
Sentry.init(sentryOptions("worker", "nodejs"));

const modules: ModuleWorker[] = [identity, catalogue, billing, enquiry, ai, reviews, wishlist];
const consumer = `${hostname()}-${process.pid}`;
let running = true;

async function loop(name: string, fn: () => Promise<unknown>, idleMs: number) {
  while (running) {
    try {
      await fn();
    } catch (err) {
      console.error(`[worker] ${name} failed`, err);
      Sentry.captureException(err, { tags: { loop: name } });
    }
    await new Promise((r) => setTimeout(r, idleMs));
  }
}

console.log(`[worker] starting ${consumer}: ${modules.map((m) => m.name).join(", ")}`);
void loop("relay", () => relayOutbox(), 250);
const queue = getJobQueue();
for (const m of modules) {
  if (Object.keys(m.handlers).length) void loop(`consume:${m.name}`, () => consumeOnce(m.name, consumer, m.handlers), 0);
  for (const job of m.jobs) void loop(`job:${m.name}:${job.name}`, job.run, job.everyMs);
  for (const q of m.queues ?? []) {
    const topic = q.topic as JobTopic;
    void loop(`delayed:${topic}`, () => queue.promoteDelayed(topic), 1000);
    for (let i = 0; i < (q.concurrency ?? 1); i++) {
      void loop(`queue:${m.name}:${topic}#${i}`, () => queue.consume(topic, m.name, `${consumer}-${i}`, q.handler), 0);
    }
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    running = false;
    console.log(`[worker] ${sig}, stopping`);
    setTimeout(() => process.exit(0), 1500);
  });
}
