// Request-level helpers: CSRF origin check, open-redirect guard, rate-limit presets, SSRF guard and an
// audit-friendly security event logger. Framework-free (standard Request/Response only).
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { DomainError, rateLimit } from "@cnote/core";
import { clientIp } from "./client-ip";
import type { PublicTarget } from "./pinned-fetch";

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
  | "passkey.registered"
  | "passkey.verified"
  | "passkey.failed"
  | "passkey.revoked"
  | "passkey.clone_suspected"
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
const EMAIL = /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,24}/gi;

function redact(v: unknown, depth = 0): unknown {
  if (v == null) return v;
  if (depth > 4) return typeof v === "object" || typeof v === "string" ? "[truncated]" : v; // fail closed: never log unscrubbed deep data
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
function isPrivateV4(a: number, b: number, c: number): boolean {
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224
  );
}

/** Expand an IPv6 literal (compressed, dotted-tail, zone id) into eight 16-bit groups; null if unparseable. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const tail = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (tail) {
    const [, a, b, c, d] = tail.map(Number) as [number, number, number, number, number];
    s = `${s.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b, c] = ip.split(".").map(Number) as [number, number, number];
    return isPrivateV4(a, b, c);
  }
  if (v === 6) {
    const g = ipv6Groups(ip);
    if (!g) return true; // fail closed
    const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
    const embedded = (hi: number, lo: number) => isPrivateV4(hi >> 8, hi & 255, lo >> 8);
    if (g.slice(0, 5).every((x) => x === 0)) {
      if (g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true; // :: and ::1
      if (g5 === 0xffff || g5 === 0) return embedded(g6, g7); // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible), in dotted or hex form
    }
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embedded(g6, g7); // NAT64
    if (g0 === 0x2002) return embedded(g1, g2); // 6to4
    return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0 || (g0 & 0xff00) === 0xff00;
  }
  return true;
}

/**
 * Outbound-fetch guard for user-supplied URLs (webhooks, image imports, domain verification): https only
 * (http allowed with `allowHttp`), no credentials, and every resolved address must be public. DNS is resolved ONCE and
 * the validated address is returned so the caller can connect to exactly that IP (`pinnedFetch`): resolve-then-fetch
 * with a second, separate lookup is a DNS-rebinding TOCTOU.
 */
export async function assertPublicHttpTarget(raw: string, opts: { allowHttp?: boolean } = {}): Promise<PublicTarget> {
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
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) block("local-host");
  const literal = isIP(host);
  if (literal) {
    if (isPrivateAddress(host)) block("private-ip");
    return { url: u, address: host, family: literal as 4 | 6 };
  }
  const addrs = await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) block("private-or-unresolvable");
  const first = addrs[0]!;
  return { url: u, address: first.address, family: (first.family === 6 ? 6 : 4) };
}

/** URL-only form of `assertPublicHttpTarget` (validation without pinning; prefer the target form + `pinnedFetch`). */
export async function assertPublicHttpUrl(raw: string, opts: { allowHttp?: boolean } = {}): Promise<URL> {
  return (await assertPublicHttpTarget(raw, opts)).url;
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
    const ip = clientIp(req.headers) ?? "unknown";
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
