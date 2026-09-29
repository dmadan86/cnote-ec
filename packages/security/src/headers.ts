// Response security headers for every app (defence in depth on top of CSP). Edge-safe.
import { buildCsp, CSP_REPORT_PATH, isReportOnly, type CspOptions, type SecurityApp } from "./csp";

export interface HeaderOptions extends CspOptions {
  /** Permit the microphone (voice notes) for this response; default off. */
  microphone?: boolean;
  camera?: boolean;
  geolocation?: boolean;
  /** Force enforce/report-only regardless of CSP_REPORT_ONLY. */
  reportOnly?: boolean;
}

const PRIVATE_APPS: readonly SecurityApp[] = ["admin", "seller", "studio"];

const perm = (on: boolean | undefined) => (on ? "(self)" : "()");

/** Header name → value. Includes the CSP under `Content-Security-Policy` or `Content-Security-Policy-Report-Only`. */
export function securityHeaders(opts: HeaderOptions): Record<string, string> {
  const env = opts.env ?? process.env;
  const prod = env.NODE_ENV === "production";
  const isPrivate = PRIVATE_APPS.includes(opts.app);
  const reportOnly = opts.reportOnly ?? isReportOnly(env);
  const h: Record<string, string> = {
    [reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy"]: buildCsp(opts),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": opts.app === "web" ? "SAMEORIGIN" : "DENY",
    // The admin console never leaks its URLs; elsewhere keep origin for analytics/attribution.
    "Referrer-Policy": opts.app === "admin" ? "no-referrer" : "strict-origin-when-cross-origin",
    "Permissions-Policy": [
      `camera=${perm(opts.camera)}`,
      `microphone=${perm(opts.microphone)}`,
      `geolocation=${perm(opts.geolocation)}`,
      "payment=()",
      "usb=()",
      "serial=()",
      "bluetooth=()",
      "interest-cohort=()",
    ].join(", "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-site",
    "Origin-Agent-Cluster": "?1",
    "X-Permitted-Cross-Domain-Policies": "none",
    "X-DNS-Prefetch-Control": "off",
  };
  if (opts.reportUri !== false) h["Reporting-Endpoints"] = `csp="${opts.reportUri ?? CSP_REPORT_PATH}"`;
  if (prod) h["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  if (isPrivate) h["X-Robots-Tag"] = "noindex, nofollow, noarchive";
  return h;
}

/** Same headers as `{ key, value }[]` for next.config.ts `headers()` (static mode: no nonce). */
export function staticHeaderList(opts: Omit<HeaderOptions, "nonce">): { key: string; value: string }[] {
  return Object.entries(securityHeaders(opts)).map(([key, value]) => ({ key, value }));
}
