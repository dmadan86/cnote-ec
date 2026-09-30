// Server start: fail fast on insecure/missing secrets in production (never during `next build`), then Sentry
// (no-op until SENTRY_DSN is set). See @cnote/security and @cnote/observability.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { assertRequiredSecrets } = await import("@cnote/security");
    assertRequiredSecrets("seller");
    (await import("@cnote/compliance")).assertIndiaResidency();
  }
  const { sentryOptions } = await import("@cnote/observability");
  if (process.env.NEXT_RUNTIME === "nodejs") Sentry.init(sentryOptions("seller", "nodejs"));
  if (process.env.NEXT_RUNTIME === "edge") Sentry.init(sentryOptions("seller", "edge"));
}

export const onRequestError = Sentry.captureRequestError;
