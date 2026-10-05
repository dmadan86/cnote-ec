// Content-Security-Policy builder. Edge-safe: no node:* imports, so the same module runs in a Next 16
// `proxy.ts`, a Cloudflare Worker or a route handler.
//
// Two modes (see docs/security/security-architecture.md):
//  - nonce mode  (nonce given): script-src 'self' 'nonce-…' 'strict-dynamic'. Only valid for pages that are
//    rendered per request (Next only stamps the nonce during dynamic rendering).
//  - static mode (no nonce): script-src 'self' 'unsafe-inline'. For statically generated / ISR pages, which
//    cannot carry a per-request nonce. Every other directive is identical.

export type SecurityApp = "web" | "seller" | "admin" | "studio" | "api";

/** Where browsers POST violation reports. Each app mounts `handleCspReport` here. */
export const CSP_REPORT_PATH = "/api/csp-report";

export interface CspAllow {
  scripts?: string[];
  connect?: string[];
  img?: string[];
  frames?: string[];
  styles?: string[];
  fonts?: string[];
}

type Env = Record<string, string | undefined>;

export interface CspOptions {
  app: SecurityApp;
  /** Per-request nonce (see createNonce). Omit for static mode. */
  nonce?: string;
  /** Violation report endpoint; false disables reporting. Default CSP_REPORT_PATH. */
  reportUri?: string | false;
  allow?: CspAllow;
  /** Allow Cloudflare Turnstile (script + frame + connect). Default: on for web/seller when NEXT_PUBLIC_TURNSTILE_SITE_KEY is set. */
  forms?: boolean;
  /** Allow Microsoft Clarity. Web only. Default: on when NEXT_PUBLIC_CLARITY_PROJECT_ID is set. */
  analytics?: boolean;
  /**
   * Allow the privacy-enhanced third-party embeds of seller storefronts in `frame-src` (EMBED_FRAME_ORIGINS). Web only; default on.
   * The frames still load only after the visitor's consent (the buyer web's <ConsentGate>): the CSP is the second line of defence, so
   * a page can never frame any other origin.
   */
  embeds?: boolean;
  /** Nonce <style> elements and keep 'unsafe-inline' only for style attributes (CSP_STRICT_STYLES=1). Needs nonce mode. */
  strictStyles?: boolean;
  /** Override process.env (tests, edge runtimes). */
  env?: Env;
}

export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
const CLARITY_SCRIPT = "https://www.clarity.ms";
const CLARITY_CONNECT = ["https://*.clarity.ms", "https://c.bing.com"];
const GOOGLE_ACCOUNTS = "https://accounts.google.com";
/**
 * The only third-party origins a page may frame: the storefront `embed` block's providers (YouTube via the privacy-enhanced
 * youtube-nocookie.com host, OpenStreetMap). Mirrors EMBED_FRAME_ORIGINS in @cnote/storefront (apps/web/test/consent-gate.test.ts
 * asserts they stay equal; security may not depend on storefront).
 */
export const EMBED_FRAME_ORIGINS = ["https://www.youtube-nocookie.com", "https://www.openstreetmap.org", "https://player.vimeo.com"] as const;

const truthy = (v: string | undefined) => v === "1" || v === "true";

/** Origin ("https://host") of a URL-ish string, or null. */
export function originOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const o = new URL(url).origin;
    return o === "null" ? null : o;
  } catch {
    return null;
  }
}

/** Sentry ingest origin from a DSN like https://key@o123.ingest.sentry.io/456. */
export function sentryOrigin(env: Env = process.env): string | null {
  return originOf(env.NEXT_PUBLIC_SENTRY_DSN || env.SENTRY_DSN);
}

const uniq = (xs: (string | null | undefined | false)[]) => [...new Set(xs.filter((x): x is string => !!x))];

/** Reject anything that could smuggle a second directive or header line. */
function assertSource(s: string): string {
  if (/[;,\s\r\n]/.test(s)) throw new Error(`Invalid CSP source expression: ${JSON.stringify(s)}`);
  return s;
}

export function buildCsp(opts: CspOptions): string {
  const env = opts.env ?? process.env;
  const { app, nonce } = opts;
  const prod = env.NODE_ENV === "production";
  const dev = env.NODE_ENV === "development";
  const allow = opts.allow ?? {};
  const turnstile = opts.forms ?? ((app === "web" || app === "seller") && !!env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
  const embeds = app === "web" && (opts.embeds ?? true);
  const clarity = app === "web" && (opts.analytics ?? !!env.NEXT_PUBLIC_CLARITY_PROJECT_ID);
  const strictStyles = !!nonce && (opts.strictStyles ?? truthy(env.CSP_STRICT_STYLES));
  const media = originOf(env.MEDIA_PUBLIC_BASE_URL);
  const sentry = sentryOrigin(env);
  if (nonce && !/^[A-Za-z0-9+/_=-]+$/.test(nonce)) throw new Error("Invalid CSP nonce");

  const scriptHosts = uniq([clarity && CLARITY_SCRIPT, turnstile && TURNSTILE_ORIGIN, ...(allow.scripts ?? [])]);
  const scriptSrc = uniq([
    "'self'",
    nonce ? `'nonce-${nonce}'` : "'unsafe-inline'",
    nonce && "'strict-dynamic'",
    dev && "'unsafe-eval'",
    ...scriptHosts,
  ]);

  const d: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": scriptSrc,
    "img-src": uniq(["'self'", "data:", "blob:", media, clarity && "https://*.clarity.ms", clarity && "https://c.bing.com", ...(allow.img ?? [])]),
    "font-src": uniq(["'self'", "data:", ...(allow.fonts ?? [])]),
    "connect-src": uniq(["'self'", dev && "ws:", dev && "wss:", sentry, ...(clarity ? CLARITY_CONNECT : []), turnstile && TURNSTILE_ORIGIN, ...(allow.connect ?? [])]),
    "media-src": uniq(["'self'", "blob:", media]),
    "frame-src": uniq([turnstile && TURNSTILE_ORIGIN, ...(embeds ? EMBED_FRAME_ORIGINS : []), ...(allow.frames ?? [])]),
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": app === "api" ? ["'none'"] : ["'self'", GOOGLE_ACCOUNTS],
    "frame-ancestors": app === "web" ? ["'self'"] : ["'none'"],
  };
  if (strictStyles) {
    // React/Radix/next-font emit style="" attributes, which only 'unsafe-inline' permits; <style> elements need the nonce.
    d["style-src-elem"] = uniq(["'self'", `'nonce-${nonce}'`, ...(allow.styles ?? [])]);
    d["style-src-attr"] = ["'unsafe-inline'"];
    d["style-src"] = ["'self'"];
  } else {
    // Next 16 + Tailwind + React style props need inline styles; script execution is the XSS-critical directive.
    d["style-src"] = uniq(["'self'", "'unsafe-inline'", ...(allow.styles ?? [])]);
  }
  if (prod) d["upgrade-insecure-requests"] = [];
  const reportUri = opts.reportUri === undefined ? CSP_REPORT_PATH : opts.reportUri;
  if (reportUri) {
    d["report-uri"] = [assertSource(reportUri)];
    d["report-to"] = ["csp"];
  }

  if (d["frame-src"]!.length === 0) d["frame-src"] = ["'none'"];
  const order = Object.keys(d);
  return order.map((k) => [k, ...d[k]!.map(assertSource)].join(" ")).join("; ");
}

/** CSP_REPORT_ONLY=1 switches every app to Content-Security-Policy-Report-Only (roll out, watch reports, then enforce). */
export function isReportOnly(env: Env = process.env): boolean {
  return truthy(env.CSP_REPORT_ONLY);
}
