// Browser Sentry (no-op until NEXT_PUBLIC_SENTRY_DSN is set). Session replay is intentionally off:
// it would capture PII (ADR-010).
import { sentryOptions } from "@cnote/observability";
import * as Sentry from "@sentry/nextjs";

Sentry.init(sentryOptions("seller", "browser"));

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
