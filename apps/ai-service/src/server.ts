import { assertIndiaResidency } from "@cnote/compliance";
import { serve } from "@hono/node-server";
import { sentryOptions } from "@cnote/observability";
import * as Sentry from "@sentry/node";

// No-op without SENTRY_DSN; PII scrubbing as in every other app (ADR-010).
Sentry.init(sentryOptions("ai-service", "nodejs"));

// Must be set before @cnote/ai selects providers: this process IS the in-process implementation.
process.env.AI_TRANSPORT = "inproc";

const { createApp } = await import("./app");
const { loadConfig } = await import("./env");

const config = loadConfig();
if (process.env.NODE_ENV === "production" && config.tokenSecret.length < 32) throw new Error("Refusing to start ai-service: AI_SERVICE_TOKEN_SECRET must be set (>= 32 chars)");
// ADR-010: refuse non-India data stores when DATA_RESIDENCY_ENFORCE=true; the AI provider check reports external model calls.
assertIndiaResidency();

const app = createApp({ config });
const server = serve({ fetch: app.fetch, port: config.port }, (info) => console.log(`cnote ai-service listening on :${info.port}`));

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, draining`);
  const force = setTimeout(() => process.exit(1), 25_000);
  force.unref();
  await new Promise<void>((r) => server.close(() => r()));
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
