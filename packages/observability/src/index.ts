// Shared observability settings for every app and the worker. Deliberately SDK-free: each app
// passes these options to its own Sentry SDK (@sentry/nextjs or @sentry/node).
// Everything is env-driven and a no-op until a DSN is configured.

export type AppName = "web" | "seller" | "admin" | "studio" | "worker" | "api" | "ai-service" | "search-service";
export type Runtime = "nodejs" | "edge" | "browser";

// Masks PII before anything leaves our infrastructure (ADR-010: DPDP, India data residency).
const PII_PATTERNS: [RegExp, string][] = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  // Indian mobiles, with optional +91/0 prefix and common separators ("98765 43210", "98765-43210").
  // The prefix is glued to the number ("+919876543210", "09876543210"), so no \b sits between prefix and first digit.
  [/(?:(?:\+?91[\s-]?|\b0)[6-9]|\b[6-9])\d{4}[\s-]?\d{5}\b/g, "[phone]"],
  // GSTIN/PAN are matched case-insensitively: users type them in lowercase too.
  [/\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/gi, "[gstin]"],
  [/\b[A-Z]{5}\d{4}[A-Z]\b/gi, "[pan]"],
  [/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, "[aadhaar]"],
];
const SECRET_KEYS = /pass(word)?|token|secret|authorization|cookie|otp|code_verifier|refresh|jwt|api[-_]?key/i;

// Credentials carried in URLs (password-reset/verification tokens, OAuth `code`/`state`, API keys, signed-URL
// signatures) — redacted wherever a URL-ish `key=value` appears: request URLs, query_string, breadcrumbs, messages.
const SECRET_QUERY = /([?&;]|^)((?:[\w.-]*(?:pass(?:word)?|token|secret|otp|code|state|nonce|jwt|api[-_]?key|key|signature|sig|session|auth)[\w.-]*|x-amz-[\w-]+))=([^&#\s"'<>]*)/gi;

// Irregularly spaced/dashed digit runs and STD landlines; the digit count decides (mirrors @cnote/ai redact.ts).
const PHONE_LOOSE = /(?<![\w.])(?:\+\s?)?\d(?:[\s().-]{0,4}\d){7,14}(?![\w])/g;
function isIndianPhoneDigits(d: string): boolean {
  if (d.length === 10) return /^[6-9]/.test(d);
  if (d.length === 11) return d[0] === "0" && /^[1-9]/.test(d[1]!);
  if (d.length === 12) return d.startsWith("91") && /^[1-9]/.test(d[2]!);
  if (d.length === 13) return d.startsWith("910") && /^[1-9]/.test(d[3]!);
  return false;
}
/** Strings are truncated before any regex runs (ReDoS bound). */
const MAX_SCRUB_CHARS = 20_000;

export function scrubString(input: string): string {
  const s = input.length > MAX_SCRUB_CHARS ? `${input.slice(0, MAX_SCRUB_CHARS)} [truncated]` : input;
  // loose phone pass first: the strict patterns would otherwise eat the tail of "+91 0 98765 43210" and leave the prefix digits
  const masked = PII_PATTERNS.reduce((acc, [re, sub]) => acc.replace(re, sub), s.replace(PHONE_LOOSE, (m) => (isIndianPhoneDigits(m.replace(/\D/g, "")) ? "[phone]" : m)));
  return masked.replace(SECRET_QUERY, (_m, sep: string, key: string) => `${sep}${key}=[redacted]`);
}

/** Recursively masks PII in strings and drops values under secret-looking keys. */
export function scrub<T>(value: T, depth = 0): T {
  if (value == null) return value;
  // Fail closed: anything nested deeper than the limit is dropped rather than passed through unscrubbed.
  if (depth > 8) return (typeof value === "object" || typeof value === "string" ? "[truncated]" : value) as T;
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
