// Background process: relays the outbox to the event transport, runs each module's event handlers
// (observers; one consumer group per module), work-queue consumers (email, notifications, …) and
// scheduled jobs. Modules plug in via their `worker` export; transports come from QUEUE_DRIVER.
import * as Sentry from "@sentry/node";
import { sentryOptions } from "@cnote/observability";
import { worker as ai } from "@cnote/ai";
import { worker as billing, setCouponPort, couponPortFromModule } from "@cnote/billing";
import { worker as promotions, couponPort } from "@cnote/promotions";
import { worker as ads } from "@cnote/ads";
import { worker as verticals } from "@cnote/verticals";
import { worker as quality } from "@cnote/quality";
import { worker as ondc, wireOndcOrderSink } from "@cnote/ondc";
import { worker as escrow } from "@cnote/escrow";
import { worker as negotiation } from "@cnote/negotiation";
import { worker as disputes, wireDisputeAdapters } from "@cnote/disputes";
import { worker as prices } from "@cnote/prices";
import { worker as credit } from "@cnote/credit";
import { worker as a2a } from "@cnote/a2a";
import { worker as analytics, setBusinessStateResolver } from "@cnote/analytics";
import { setPartyResolvers } from "@cnote/notifications";
import { getOrderParties } from "@cnote/enquiry";
import { getOndcOrderSeller } from "@cnote/ondc";
import { getCreditApplicationBusiness } from "@cnote/credit";
import { getNegotiationParties } from "@cnote/a2a";
import { getTrustProfiles } from "@cnote/identity";
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
import { worker as metrics } from "@cnote/metrics";
import { assertIndiaResidency, worker as compliance } from "@cnote/compliance";
import { REACHABILITY_COPY, setReachabilityNotifier } from "@cnote/enquiry";
import { extractDocument } from "@cnote/ai";
import { getSmsSender, setKycPorts } from "@cnote/identity";
import { ImageValidationError, getMediaStore, validateImage } from "@cnote/media";
import { sendToPhone, worker as whatsapp } from "@cnote/whatsapp";
import { seedStorefrontTemplates, worker as storefront } from "@cnote/storefront";
import { assertRequiredSecrets } from "@cnote/security";
import { cacheWorker, searchIndexer } from "@cnote/search";
import { seedDefaultTemplates } from "@cnote/templates";
import { worker as wishlist } from "@cnote/wishlist";
import { hostname } from "node:os";

assertRequiredSecrets("worker");
// DPDP/ADR-010: refuse to start against non-India data stores when DATA_RESIDENCY_ENFORCE=true (warns otherwise).
assertIndiaResidency();
// No-op until SENTRY_DSN is set.
Sentry.init(sentryOptions("worker", "nodejs"));
// identity can't import catalogue (cycle); the composition root supplies the GST HSN-alignment source.
setListingHsnSource(getSellerListingHsns);

const modules: ModuleWorker[] = [identity, catalogue, billing, enquiry, ai, reviews, wishlist, notifications, developer, email, cacheWorker, searchIndexer, leadgen, domains, storefront, bulk, metrics, compliance, whatsapp, promotions, ads, verticals, quality, ondc, escrow, negotiation, disputes, prices, credit, a2a, analytics];
// Seller-cohort facts group sellers by state (identity owns it; analytics reads it through this resolver).
// Phase 2/3 notifications: events name an order/application/negotiation, not the parties (see docs/design/notifications-phase23.md).
setPartyResolvers({ orderParties: getOrderParties, ondcOrderSeller: getOndcOrderSeller, creditApplicationBusiness: getCreditApplicationBusiness, negotiationParties: getNegotiationParties });
setBusinessStateResolver(async (ids) => new Map([...(await getTrustProfiles(ids))].map(([id, p]) => [id, p.state])));
wireDisputeAdapters();
wireOndcOrderSink();
setCouponPort(couponPortFromModule(couponPort));
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

// KYC ports (identity may not depend on ai/media): the retention purge deletes document images from the private store.
setKycPorts({
  store: {
    put: (k, b, ct) => getMediaStore("private").put(k, b, ct),
    get: (k) => getMediaStore("private").get(k),
    delete: (k) => getMediaStore("private").delete(k),
  },
  inspectImage: (bytes) => {
    try {
      const v = validateImage(bytes);
      return { mime: v.mime, ext: v.ext, width: v.width, height: v.height, sha256: v.sha256 };
    } catch (err) {
      throw err instanceof ImageValidationError ? err : new Error("Invalid image");
    }
  },
  extractDocument: (input, subject) => extractDocument({ image: input.image, docType: input.docType }, subject),
});

// ADR-002 buyer reachability: WhatsApp utility template first (title + one-tap link), SMS fallback. Registered here
// because only the worker delivers (enquiry queues the dispatch); throwing = delivery failure = seller refunded.
setReachabilityNotifier({
  async send(m) {
    const hi = m.language === "hi";
    const wa = await sendToPhone({
      phone: m.phone,
      template: { name: m.template, language: hi ? "hi" : "en", bodyParams: [m.enquiryTitle.slice(0, 60), m.link], category: "utility" },
    });
    if (wa.sent) return { channel: "whatsapp" };
    const text = (hi ? REACHABILITY_COPY.sms.hi : REACHABILITY_COPY.sms.en).replace("{{1}}", m.enquiryTitle.slice(0, 40)).replace("{{2}}", m.link);
    await getSmsSender().send({ to: m.phone, text });
    return { channel: "sms" };
  },
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
