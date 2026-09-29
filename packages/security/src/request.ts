// Request-level helpers: CSRF origin check, open-redirect guard, rate-limit presets, SSRF guard and an
// audit-friendly security event logger. Framework-free (standard Request/Response only).
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { DomainError, rateLimit } from "@cnote/core";

// ---------- CSRF: same-origin ----------
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function expectedOrigin(req: Request): string {
  const h = req.headers;
  const host = h.get("x-forwarded-host")?.split(",")[0]?.trim() || h.get("host");
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const url = new URL(req.url);
  if (!host) return url.origin;
  return `${proto ?? url.protocol.replace(":", "")}://${host}`;
}

/**
 * True for safe methods and for requests whose Origin (or Referer) matches this deployment. Browsers always
 * send Origin on cross-site POSTs, so a missing Origin + Sec-Fetch-Site of same-origin/none is a same-origin
 * or non-browser client. `extraOrigins` allows e.g. a storefront custom domain.
 */
export function isSameOrigin(req: Request, extraOrigins: string[] = []): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
  const allowed = new Set([expectedOrigin(req), new URL(req.url).origin, ...extraOrigins]);
  const origin = req.headers.get("origin");
  if (origin) return origin !== "null" && allowed.has(origin);
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return allowed.has(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  return true; // no browser context headers: not a cross-site browser request
}

/** Throws DomainError("forbidden") for cross-site state-changing requests. Use at the top of POST/PUT/PATCH/DELETE route handlers. */
export function assertSameOrigin(req: Request, extraOrigins: string[] = []): void {
  if (!isSameOrigin(req, extraOrigins)) {
    logSecurityEvent("csrf.blocked", { method: req.method, path: new URL(req.url).pathname, origin: req.headers.get("origin") });
    throw new DomainError("forbidden", "Cross-site request blocked.");
  }
}

// ---------- open redirect ----------
/** Same-origin relative path only; anything else returns `fallback`. Blocks //host, /\host, schemes and control chars. */
export function safeRedirectPath(next: string | null | undefined, fallback = "/"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || /[\u0000-\u001f\\]/.test(next)) return fallback;
  try {
    if (new URL(next, "http://local.invalid").origin !== "http://local.invalid") return fallback;
  } catch {
    return fallback;
  }
  return next;
}

/** Absolute http(s) URL whose host is allow-listed (exact or subdomain), else fallback. */
export function safeRedirectUrl(target: string | null | undefined, allowedHosts: string[], fallback: string): string {
  if (!target) return fallback;
  try {
    const u = new URL(target);
    if (u.protocol !== "https:" && u.protocol !== "http:") return fallback;
    if (u.username || u.password) return fallback;
    const host = u.hostname.toLowerCase();
    return allowedHosts.some((a) => host === a || host.endsWith(`.${a}`)) ? u.toString() : fallback;
  } catch {
    return fallback;
  }
}

// ---------- rate-limit presets ----------
export interface RateLimitPreset {
  limit: number;
  windowSeconds: number;
  message: string;
}
/** Suggested budgets. Cloudflare rate-limiting rules (edge) should be looser than these (app) so the app limit gives the friendly error. */
export const RATE_LIMITS = {
  signIn: { limit: 20, windowSeconds: 60, message: "Too many sign-in attempts. Please wait a minute." },
  signUp: { limit: 5, windowSeconds: 3600, message: "Too many sign-up attempts. Please try again later." },
  passwordReset: { limit: 3, windowSeconds: 3600, message: "Too many reset requests. Please try again later." },
  otpRequest: { limit: 5, windowSeconds: 3600, message: "Too many code requests. Please try again later." },
  otpVerify: { limit: 10, windowSeconds: 900, message: "Too many attempts. Please try again later." },
  mfaVerify: { limit: 8, windowSeconds: 300, message: "Too many verification attempts. Please wait a few minutes." },
  apiRead: { limit: 120, windowSeconds: 60, message: "Rate limit exceeded." },
  apiWrite: { limit: 30, windowSeconds: 60, message: "Rate limit exceeded." },
  cspReport: { limit: 60, windowSeconds: 60, message: "Too many reports." },
} as const satisfies Record<string, RateLimitPreset>;

/** Fixed-window limit by preset; throws DomainError("rate_limited"). `subject` is an IP, person id, email, … */
export async function enforceRateLimit(preset: keyof typeof RATE_LIMITS, subject: string): Promise<void> {
  const p: RateLimitPreset = RATE_LIMITS[preset];
  if (!(await rateLimit(`sec:${preset}:${subject}`, p.limit, p.windowSeconds))) {
    logSecurityEvent("rate_limit.exceeded", { preset, subject: redactSubject(subject) });
    throw new DomainError("rate_limited", p.message);
  }
}

// ---------- security events ----------
export type SecurityEventType =
  | "csrf.blocked"
  | "csp.violation"
  | "rate_limit.exceeded"
  | "human.rejected"
  | "auth.signin_failed"
  | "mfa.enrolled"
  | "mfa.disabled"
  | "mfa.verified"
  | "mfa.failed"
  | "mfa.recovery_used"
  | "ssrf.blocked"
  | "secrets.invalid"
  | (string & {});

export interface SecurityEvent {
  type: SecurityEventType;
  at: string;
  data: Record<string, unknown>;
}
export type SecurityEventSink = (event: SecurityEvent) => void;

const SECRET_KEY = /pass(word)?|token|secret|authorization|cookie|otp|code|api[-_]?key|jwt/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function redact(v: unknown, depth = 0): unknown {
  if (v == null || depth > 4) return v;
  if (typeof v === "string") return v.replace(EMAIL, "[email]").slice(0, 500);
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, depth + 1));
  if (typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? "[redacted]" : redact(x, depth + 1)]));
  return v;
}
const redactSubject = (s: string) => s.replace(EMAIL, "[email]");

let sink: SecurityEventSink = (e) => console.warn(JSON.stringify({ level: "security", event: e.type, at: e.at, ...(e.data as object) }));
/** Route events elsewhere (e.g. persist to the admin audit log or ship to a SIEM). Returns the previous sink. */
export function setSecurityEventSink(next: SecurityEventSink): SecurityEventSink {
  const prev = sink;
  sink = next;
  return prev;
}

/** One structured JSON line per event with secrets dropped and emails masked; never throws. */
export function logSecurityEvent(type: SecurityEventType, data: Record<string, unknown> = {}): void {
  try {
    sink({ type, at: new Date().toISOString(), data: redact(data) as Record<string, unknown> });
  } catch {
    /* logging must never break a request */
  }
}

// ---------- SSRF guard ----------
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^(fc|fd|fe[89ab])/.test(s) || s.startsWith("ff");
  }
  return true;
}

/**
 * Outbound-fetch guard for user-supplied URLs (webhooks, image imports, domain verification): https only
 * (http allowed with `allowHttp`), no credentials, and every resolved address must be public. Returns the URL.
 * Note: resolve-then-fetch is still racy (DNS rebinding); pin the resolved IP in the HTTP client for hostile inputs.
 */
export async function assertPublicHttpUrl(raw: string, opts: { allowHttp?: boolean } = {}): Promise<URL> {
  const block = (why: string): never => {
    logSecurityEvent("ssrf.blocked", { why, url: raw.slice(0, 200) });
    throw new DomainError("validation", "That URL is not allowed.");
  };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return block("unparseable");
  }
  if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) block("scheme");
  if (u.username || u.password) block("credentials");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) block("local-host");
  if (isIP(host)) {
    if (isPrivateAddress(host)) block("private-ip");
  } else {
    const addrs = await lookup(host, { all: true }).catch(() => []);
    if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) block("private-or-unresolvable");
  }
  return u;
}

// ---------- CSP report endpoint ----------
/**
 * Route handler body for CSP_REPORT_PATH. Accepts `application/csp-report` (report-uri) and
 * `application/reports+json` (report-to); logs each violation as a "csp.violation" security event. Always 204.
 */
export async function handleCspReport(req: Request): Promise<Response> {
  const done = new Response(null, { status: 204 });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("cf-connecting-ip") || "unknown";
    if (!(await rateLimit(`sec:cspReport:${ip}`, RATE_LIMITS.cspReport.limit, RATE_LIMITS.cspReport.windowSeconds))) return done;
    const text = await req.text();
    if (text.length > 16_384) return done;
    const json = JSON.parse(text) as unknown;
    const items = Array.isArray(json) ? json : [json];
    for (const item of items.slice(0, 5)) {
      const body = ((item as { body?: unknown })?.body ?? (item as { "csp-report"?: unknown })?.["csp-report"] ?? {}) as Record<string, unknown>;
      const strip = (u: unknown) => (typeof u === "string" ? u.split(/[?#]/)[0] : u);
      logSecurityEvent("csp.violation", {
        directive: body["effective-directive"] ?? body.effectiveDirective ?? body["violated-directive"],
        blocked: strip(body["blocked-uri"] ?? body.blockedURL),
        document: strip(body["document-uri"] ?? body.documentURL),
        source: strip(body["source-file"] ?? body.sourceFile),
        line: body["line-number"] ?? body.lineNumber,
        disposition: body.disposition,
      });
    }
  } catch {
    /* malformed report: ignore */
  }
  return done;
}
