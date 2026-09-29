// Security headers + CSP nonce plumbing for Next 16 `proxy.ts`. No `server-only` and no static next/headers
// import, so it is safe in the proxy bundle (and re-exported from the package index for Server Components).
//
//   const nonce = createNonce();
//   const res = await inner(withNonceRequest(req, nonce, { app: "web" }));   // Next stamps the nonce on its scripts
//   return withSecurityHeaders(res, { app: "web", nonce });                    // and the browser enforces the CSP
//
// Static/ISR pages cannot carry a per-request nonce: omit `nonce` for them (static-mode CSP).
import { securityHeaders, type HeaderOptions, type SecurityApp } from "@cnote/security";
import { NextRequest, NextResponse } from "next/server";

/** Request header carrying the nonce to Server Components (`(await headers()).get("x-nonce")`). */
export const NONCE_HEADER = "x-nonce";

/** 128-bit random nonce, base64. Web Crypto only (works on the edge runtime too). */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export type SecurityOptions = Omit<HeaderOptions, "env">;

const CSP_NAMES = ["Content-Security-Policy", "Content-Security-Policy-Report-Only"] as const;

/**
 * Sets every security header (CSP, HSTS, COOP/CORP, Permissions-Policy, …) on a response, redirects
 * included. Existing values are overwritten: the proxy is the single source of truth.
 */
export function withSecurityHeaders<R extends Response>(res: R, opts: SecurityOptions): R {
  for (const [k, v] of Object.entries(securityHeaders(opts))) res.headers.set(k, v);
  return res;
}

/**
 * Clone the request with the nonce and CSP on its headers. Next reads the CSP request header during
 * rendering to learn the nonce and stamps it onto framework scripts; Server Components read `x-nonce`.
 * Pass the returned request to the inner proxy (e.g. createAuthProxy) so its NextResponse.next() forwards them.
 */
export function withNonceRequest(req: NextRequest, nonce: string, opts: SecurityOptions): NextRequest {
  const headers = new Headers(req.headers);
  headers.set(NONCE_HEADER, nonce);
  const csp = securityHeaders({ ...opts, nonce });
  for (const name of CSP_NAMES) if (csp[name]) headers.set(name, csp[name]);
  return new NextRequest(req, { headers });
}

/** Convenience for proxies with no inner handler: pass through (with nonce if given) and add headers. */
export function secureNext(req: NextRequest, opts: SecurityOptions & { nonce?: string }): NextResponse {
  const { nonce } = opts;
  const res = nonce ? NextResponse.next({ request: { headers: withNonceRequest(req, nonce, opts).headers } }) : NextResponse.next();
  return withSecurityHeaders(res, opts);
}

/** The current request's CSP nonce (Server Components / route handlers), or undefined for static-mode pages. */
export async function getNonce(): Promise<string | undefined> {
  const { headers } = await import("next/headers");
  return (await headers()).get(NONCE_HEADER) ?? undefined;
}

export type { SecurityApp };

/**
 * Path predicate helper: true when `pathname` equals or is under any prefix.
 * Proxies use it to choose nonce mode (dynamic pages) vs static mode (ISR/static pages).
 */
export function pathMatches(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`));
}

/**
 * Defence in depth for the admin realm: sign-in never issues an admin session without a second factor, but
 * sessions minted before MFA was rolled out (or by a future code path) must not reach the console either.
 * Returns a redirect response to the enrollment page when the signed-in person has no MFA, else null.
 * The access token is only decoded here (the page still verifies it), so a forged cookie can at worst trigger a redirect.
 */
export async function enforceMfaEnrolled(req: NextRequest, opts: { exemptPrefixes: readonly string[]; redirectTo: string }): Promise<NextResponse | null> {
  if (pathMatches(req.nextUrl.pathname, opts.exemptPrefixes)) return null;
  const { realmCookies } = await import("./realm");
  const access = req.cookies.get(realmCookies().access)?.value;
  if (!access) return null; // unauthenticated requests are the auth proxy's business
  let sub: string | undefined;
  try {
    sub = (JSON.parse(atob((access.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: string }).sub;
  } catch {
    return null;
  }
  if (!sub) return null;
  const [{ isMfaEnabled }, { redis }] = await Promise.all([import("@cnote/identity"), import("@cnote/core")]);
  const cacheKey = `mfa:on:${sub}`;
  try {
    if ((await redis.get(cacheKey)) === "1") return null;
  } catch {
    /* Redis down: fall through to the database */
  }
  if (await isMfaEnabled(sub)) {
    await redis.set(cacheKey, "1", "EX", 60).catch(() => undefined);
    return null;
  }
  if (process.env.NODE_ENV !== "production" && process.env.MFA_ADMIN_OPTIONAL === "1") return null;
  return NextResponse.redirect(new URL(opts.redirectTo, req.url));
}
