// Server-side Sentry (no-op until SENTRY_DSN is set). See @cnote/observability for PII scrubbing.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  const { sentryOptions } = await import("@cnote/observability");
  if (process.env.NEXT_RUNTIME === "nodejs") {
    Sentry.init(sentryOptions("web", "nodejs"));
    // Cache observability: hit / miss / stale counters per key family, logged every 5 minutes (set CACHE_LOG=1 for per-key logs).
    if (process.env.CACHE_STATS_LOG !== "0") {
      const { getCacheStats } = await import("@cnote/core");
      setInterval(() => {
        const stats = getCacheStats();
        if (Object.keys(stats).length) console.log("[cache] stats", JSON.stringify(stats));
      }, 5 * 60_000).unref();
    }
  }
  if (process.env.NEXT_RUNTIME === "edge") Sentry.init(sentryOptions("web", "edge"));
}

export const onRequestError = Sentry.captureRequestError;
