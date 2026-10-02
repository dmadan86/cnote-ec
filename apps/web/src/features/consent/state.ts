// Consent record for the buyer web: the framework-free core lives in @cnote/consent (shared with the seller app); this module
// binds it to the web's cookie name and policy version so the rest of the app keeps importing from one place.
//
// The record lives in ONE first-party cookie, `cnote_consent`, holding a URL-encoded query string:
//   v=3&id=<32 hex>&a=1&m=0&f=0&t=<unix seconds>&gpc=0
// v = CONSENT_POLICY_VERSION, id = random consent id (links the receipt stored server-side), a = analytics,
// m = marketing and attribution, f = preferences & personalisation (functional; GPC does not affect it), t = when the choice was made, gpc = Global Privacy Control was on.
// Strictly necessary storage needs no consent (DPDP s.7(a)/(b); ePrivacy Art 5(3) exemptions) so it has no flag.
// Design + standards: docs/design/cookie-consent.md.
import * as core from "@cnote/consent";
import type { ConsentChoices, ConsentState } from "@cnote/consent";

export {
  acceptAllChoices, cookieValue, consentIdFromCookieValue, deriveAction, isConsentId, isGranted, needsPrompt, newConsentId, serializeConsent, REJECT_ALL,
  CONSENT_EVENT, CONSENT_OPEN_EVENT, CONSENT_MAX_AGE_SECONDS, CONSENT_ACTIONS, OPTIONAL_CATEGORIES,
  type ConsentAction, type ConsentChoices, type ConsentState, type OptionalCategory,
} from "@cnote/consent";

export const CONSENT_COOKIE = "cnote_consent";

/**
 * Bump when a NEW non-essential purpose or provider is added, or an existing one changes materially: every stored
 * choice with an older version is treated as "no choice" and everybody is asked again (fresh, specific consent).
 */
export const CONSENT_POLICY_VERSION = 4;
/** Shown on the cookie policy page. Update together with CONSENT_POLICY_VERSION. */
export const CONSENT_POLICY_UPDATED = "2026-10-02";

export const parseConsent = (raw: string | null | undefined, now?: number): ConsentState | null => core.parseConsent(raw, CONSENT_POLICY_VERSION, now);

/** Full `Set-Cookie` / `document.cookie` string. Readable by client code on purpose (islands react to it). */
export const consentCookieString = (s: ConsentState, secure: boolean): string => core.consentCookieString(CONSENT_COOKIE, s, secure);

/** Consent state from a `Cookie` request header / `document.cookie` string. */
export const readConsentFromHeader = (header: string | null | undefined, now?: number): ConsentState | null => parseConsent(core.cookieValue(header, CONSENT_COOKIE), now);

/** Server helper: marketing storage (`cnote_vid`, `cnote_ad_click`) may only be set when this is true. */
export const marketingGrantedInHeader = (header: string | null | undefined, now?: number): boolean => core.isGranted(readConsentFromHeader(header, now), "marketing");

export const buildConsent = (choices: ConsentChoices, o: { gpc: boolean; prev?: ConsentState | null; now?: number; at?: number }): ConsentState => core.buildConsent(choices, { ...o, version: CONSENT_POLICY_VERSION });
