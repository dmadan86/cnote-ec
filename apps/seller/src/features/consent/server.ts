// Server-side consent helpers for the seller app (route handlers, server actions, the proxy). Pure: no next/* imports.
// Server code must never set or read optional storage (seller_onb_t0, seller_onb_t1, seller_ref) unless the matching category is granted.
import { isGranted, parseConsent, type ConsentState, type OptionalCategory } from "@cnote/consent";
import { SELLER_CONSENT_COOKIE, SELLER_POLICY_VERSION } from "./registry";

type CookieGetter = { get(name: string): { value: string } | undefined };
/** A NextRequest / Request-like (`req.cookies`) or a cookie store such as `await cookies()` from next/headers. */
export type CookieSource = { cookies: CookieGetter } | CookieGetter;

const jarOf = (src: CookieSource): CookieGetter => ("cookies" in src ? src.cookies : src);

/** The visitor's valid consent state, or null (no choice, expired, older policy version, malformed). */
export function sellerConsent(src: CookieSource, now?: number): ConsentState | null {
  return parseConsent(jarOf(src).get(SELLER_CONSENT_COOKIE)?.value, SELLER_POLICY_VERSION, now);
}

/** True only when the visitor granted `category`. Everything not granted stays off, including before any choice. */
export const requireSellerConsent = (src: CookieSource, category: OptionalCategory, now?: number): boolean => isGranted(sellerConsent(src, now), category);
