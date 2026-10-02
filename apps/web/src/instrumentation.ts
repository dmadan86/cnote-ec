// Server start: fail fast on insecure/missing secrets in production (never during `next build`), then Sentry
// (no-op until SENTRY_DSN is set). See @cnote/security and @cnote/observability.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { assertRequiredSecrets } = await import("@cnote/security");
    assertRequiredSecrets("web");
    (await import("@cnote/compliance")).assertIndiaResidency();
    // Legal entity details (footer, /contact): loud in production when unset; fatal only when LEGAL_ENTITY_STRICT=true.
    const { assertLegalEntity } = await import("@/features/legal/entity");
    try {
      assertLegalEntity();
    } catch (e) {
      if (process.env.LEGAL_ENTITY_STRICT === "true") throw e;
      console.error(`[legal] ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const { sentryOptions } = await import("@cnote/observability");
  if (process.env.NEXT_RUNTIME === "nodejs") Sentry.init(sentryOptions("web", "nodejs"));
  if (process.env.NEXT_RUNTIME === "edge") Sentry.init(sentryOptions("web", "edge"));
}

export const onRequestError = Sentry.captureRequestError;
