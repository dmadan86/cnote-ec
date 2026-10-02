// Server-side consent helpers (route handlers and server code). Pure: no next/* imports, so it also runs in unit tests.
// The consent record is the first-party `cnote_consent` cookie (state.ts); server code must never set or read non-essential
// storage (cnote_vid, cnote_ad_click, ...) unless the matching category is granted.
import { CONSENT_COOKIE, isGranted, parseConsent, type ConsentState, type OptionalCategory } from "./state";

type CookieGetter = { get(name: string): { value: string } | undefined };
/** A NextRequest / Request-like (`req.cookies`) or a cookie store such as `await cookies()` from next/headers. */
export type CookieSource = { cookies: CookieGetter } | CookieGetter;

const jarOf = (src: CookieSource): CookieGetter => ("cookies" in src ? src.cookies : src);

/** The visitor's valid consent state, or null (no choice, expired, older policy version, malformed). */
export function consentFromRequest(src: CookieSource, now?: number): ConsentState | null {
  return parseConsent(jarOf(src).get(CONSENT_COOKIE)?.value, now);
}

/**
 * True only when the visitor granted `category`. Guard EVERY read or write of non-essential server-side storage with it:
 *   const marketing = requireConsent(req, "marketing");
 *   if (marketing && !existing) res.cookies.set("cnote_vid", ...);
 * (ePrivacy Art 5(3), DPDP s.6). Everything the visitor did not grant stays off, including before any choice.
 */
export function requireConsent(src: CookieSource, category: OptionalCategory, now?: number): boolean {
  return isGranted(consentFromRequest(src, now), category);
}
