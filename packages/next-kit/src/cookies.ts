// Cookie names/options shared by server actions, route handlers and the proxy. No next/headers import
// so it is safe in the proxy bundle.
import { ACCESS_COOKIE, ACCESS_TTL_SECONDS, REFRESH_COOKIE, REFRESH_TTL_SECONDS, type AuthTokens } from "@cnote/identity";

export const OAUTH_COOKIE = "cnote_oauth";

const base = () => ({ httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/" });

export const accessCookie = (tokens: AuthTokens) => ({
  name: ACCESS_COOKIE,
  value: tokens.accessToken,
  ...base(),
  maxAge: ACCESS_TTL_SECONDS,
});
export const refreshCookie = (tokens: AuthTokens) => ({
  name: REFRESH_COOKIE,
  value: tokens.refreshToken,
  ...base(),
  maxAge: REFRESH_TTL_SECONDS,
});

interface CookieWriter {
  set(opts: { name: string; value: string } & Record<string, unknown>): unknown;
  delete(name: string): unknown;
}
export function setAuthCookies(store: CookieWriter, tokens: AuthTokens) {
  store.set(accessCookie(tokens));
  store.set(refreshCookie(tokens));
}
export function clearAuthCookies(store: CookieWriter) {
  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
}

/** `next` must be a same-origin relative path; anything else falls back. Blocks `//host`, `/\host` and schemes. */
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || /[\u0000-\u001f\\]/.test(next)) return fallback;
  try {
    const u = new URL(next, "http://local.invalid");
    if (u.origin !== "http://local.invalid") return fallback;
  } catch {
    return fallback;
  }
  return next;
}

/** Decode `exp` (seconds) without verifying: only used to decide whether to refresh; getSession verifies. */
export function jwtExp(token: string | undefined): number | null {
  if (!token) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}
