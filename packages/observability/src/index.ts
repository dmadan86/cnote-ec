// Shared observability settings for every app and the worker. Deliberately SDK-free: each app
// passes these options to its own Sentry SDK (@sentry/nextjs or @sentry/node).
// Everything is env-driven and a no-op until a DSN is configured.

export type AppName = "web" | "seller" | "admin" | "studio" | "worker" | "api";
export type Runtime = "nodejs" | "edge" | "browser";

// Masks PII before anything leaves our infrastructure (ADR-010: DPDP, India data residency).
const PII_PATTERNS: [RegExp, string][] = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  // Indian mobiles, with optional +91/0 prefix and common separators ("98765 43210", "98765-43210").
  [/(?:\+?91[\s-]?|\b0)?\b[6-9]\d{4}[\s-]?\d{5}\b/g, "[phone]"],
  [/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g, "[gstin]"],
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, "[pan]"],
  [/\b\d{4}\s?\d{4}\s?\d{4}\b/g, "[aadhaar]"],
];
const SECRET_KEYS = /pass(word)?|token|secret|authorization|cookie|otp|code_verifier|refresh|jwt|api[-_]?key/i;

export function scrubString(s: string): string {
  return PII_PATTERNS.reduce((acc, [re, sub]) => acc.replace(re, sub), s);
}

/** Recursively masks PII in strings and drops values under secret-looking keys. */
export function scrub<T>(value: T, depth = 0): T {
  if (depth > 8 || value == null) return value;
  if (typeof value === "string") return scrubString(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1)) as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "[redacted]" : scrub(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

type SentryLikeEvent = {
  request?: { headers?: Record<string, string>; cookies?: unknown; data?: unknown; query_string?: unknown };
  user?: { id?: string | number; email?: string; ip_address?: string | null; username?: string };
  [key: string]: unknown;
};

/** beforeSend/beforeSendTransaction: keep only an opaque user id, strip cookies/headers/bodies, mask PII. */
export function scrubEvent<E>(input: E): E {
  // Generic over the SDK's own event types (ErrorEvent, TransactionEvent) so it can be passed
  // straight to beforeSend without importing the SDK here.
  const event = input as SentryLikeEvent;
  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;
    if (event.request.headers) {
      const { "user-agent": ua, referer } = event.request.headers;
      event.request.headers = { ...(ua ? { "user-agent": ua } : {}), ...(referer ? { referer: scrubString(referer) } : {}) };
    }
  }
  if (event.user) event.user = event.user.id !== undefined ? { id: event.user.id } : {};
  return scrub(event) as E;
}

function num(v: string | undefined, fallback: number): number {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/**
 * Options for Sentry.init. `dsn` is undefined (SDK disabled) until SENTRY_DSN /
 * NEXT_PUBLIC_SENTRY_DSN is set. Browser code must use NEXT_PUBLIC_* (inlined at build time).
 */
export function sentryOptions(app: AppName, runtime: Runtime, env: Record<string, string | undefined> = process.env) {
  const dsn = runtime === "browser" ? env.NEXT_PUBLIC_SENTRY_DSN : env.SENTRY_DSN || env.NEXT_PUBLIC_SENTRY_DSN;
  const environment = env.SENTRY_ENVIRONMENT || env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || env.NODE_ENV || "development";
  return {
    dsn: dsn || undefined,
    enabled: Boolean(dsn),
    environment,
    release: env.SENTRY_RELEASE || env.NEXT_PUBLIC_SENTRY_RELEASE || undefined,
    tracesSampleRate: num(env.SENTRY_TRACES_SAMPLE_RATE ?? env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE, environment === "production" ? 0.1 : 1),
    sendDefaultPii: false,
    initialScope: { tags: { app, runtime } },
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
  };
}
