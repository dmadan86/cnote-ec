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
import { worker as bulk } from "@cnote/bulk";
import { worker as developer } from "@cnote/developer";
import { worker as email } from "@cnote/email";
import { worker as notifications } from "@cnote/notifications";
import { worker as reviews } from "@cnote/reviews";
import { worker as domains } from "@cnote/domains";
import { setListingHsnSource } from "@cnote/identity";
import { getSellerListingHsns } from "@cnote/catalogue";
import { worker as leadgen } from "@cnote/leadgen";
import { seedStorefrontTemplates, worker as storefront } from "@cnote/storefront";
import { assertRequiredSecrets } from "@cnote/security";
import { cacheWorker, searchIndexer } from "@cnote/search";
import { seedDefaultTemplates } from "@cnote/templates";
import { worker as wishlist } from "@cnote/wishlist";
import { hostname } from "node:os";

assertRequiredSecrets("worker");
// No-op until SENTRY_DSN is set.
Sentry.init(sentryOptions("worker", "nodejs"));
// identity can't import catalogue (cycle); the composition root supplies the GST HSN-alignment source.
setListingHsnSource(getSellerListingHsns);

const modules: ModuleWorker[] = [identity, catalogue, billing, enquiry, ai, reviews, wishlist, notifications, developer, email, cacheWorker, searchIndexer, leadgen, domains, storefront, bulk];
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
// Templates are registered at import time by email/notifications; make sure every key has a
// published DB version before anything is sent (idempotent, never overwrites staff edits).
await seedDefaultTemplates().catch((err) => {
  console.error("[worker] template seed failed", err);
  Sentry.captureException(err);
});

// Curated Studio templates (idempotent upsert by key; never overwrites staff edits).
await seedStorefrontTemplates().catch((err) => {
  console.error("[worker] storefront template seed failed", err);
  Sentry.captureException(err);
});

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
