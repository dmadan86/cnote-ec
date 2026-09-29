import { sentryOptions } from "@cnote/observability";
import { serve } from "@hono/node-server";
import * as Sentry from "@sentry/node";
import { createApp } from "./app";
import { config } from "./env";

Sentry.init(sentryOptions("api", "nodejs"));

const app = createApp({ onServerError: (err, requestId) => void Sentry.captureException(err, { tags: { requestId } }) });
const server = serve({ fetch: app.fetch, port: config.port }, (info) => console.log(`cnote api listening on :${info.port}`));

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  await new Promise<void>((r) => server.close(() => r()));
  await Sentry.close(2000).catch(() => undefined);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
