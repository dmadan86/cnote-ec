// Cookie names/options shared by server actions, route handlers and the proxy. No next/headers import
// so it is safe in the proxy bundle.
import type { AuthTokens } from "@cnote/identity";
import { appRealm, realmCookies, realmPolicy } from "./realm";

/** PKCE/state cookie for the Google round trip, per realm so parallel sign-ins in two apps can't collide. */
export const oauthCookieName = () => `cnote_${appRealm()}_oauth`;

const base = () => ({ httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/" });

export const accessCookie = (tokens: AuthTokens) => ({
  name: realmCookies().access,
  value: tokens.accessToken,
  ...base(),
  maxAge: realmPolicy().accessTtlSeconds,
});
export const refreshCookie = (tokens: AuthTokens) => ({
  name: realmCookies().refresh,
  value: tokens.refreshToken,
  ...base(),
  // Never outlive the session's absolute expiry (admin: 12h from sign-in).
  maxAge: Math.max(0, Math.floor((new Date(tokens.refreshExpiresAt).getTime() - Date.now()) / 1000)),
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
  const names = realmCookies();
  store.delete(names.access);
  store.delete(names.refresh);
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
