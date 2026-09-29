// Server-side Sentry (no-op until SENTRY_DSN is set). See @cnote/observability for PII scrubbing.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  const { sentryOptions } = await import("@cnote/observability");
  if (process.env.NEXT_RUNTIME === "nodejs") Sentry.init(sentryOptions("admin", "nodejs"));
  if (process.env.NEXT_RUNTIME === "edge") Sentry.init(sentryOptions("admin", "edge"));
}

export const onRequestError = Sentry.captureRequestError;
