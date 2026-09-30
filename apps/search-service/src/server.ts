import { assertIndiaResidency } from "@cnote/compliance";
import { redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { serve } from "@hono/node-server";
import { sentryOptions } from "@cnote/observability";
import * as Sentry from "@sentry/node";

// No-op without SENTRY_DSN; PII scrubbing as in every other app (ADR-010).
Sentry.init(sentryOptions("search-service", "nodejs"));

// Must be set before @cnote/search picks its transport: this process IS the in-process implementation.
process.env.SEARCH_TRANSPORT = "inproc";

const { createApp } = await import("./app");
const { loadConfig } = await import("./env");

const config = loadConfig();
if (process.env.NODE_ENV === "production" && config.tokenSecret.length < 32) throw new Error("Refusing to start search-service: SEARCH_SERVICE_TOKEN_SECRET must be set (>= 32 chars)");
// ADR-010: refuse non-India data stores when DATA_RESIDENCY_ENFORCE=true.
assertIndiaResidency();

const app = createApp({ config, probes: { postgres: () => prisma.$queryRaw`SELECT 1`, redis: () => redis.ping() } });
const server = serve({ fetch: app.fetch, port: config.port }, (info) => console.log(`cnote search-service listening on :${info.port}`));

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, draining`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  await new Promise<void>((r) => server.close(() => r()));
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
