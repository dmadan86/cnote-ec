// Analytics consent (DPDP, ADR-010): Clarity records sessions, so it only loads after an explicit
// opt-in. Stored in a first-party cookie readable by client code; no PII.
export const CONSENT_COOKIE = "cnote_consent";
export const CONSENT_EVENT = "cnote:consent";
export type AnalyticsConsent = "granted" | "denied";

export function readConsent(cookieHeader: string): AnalyticsConsent | null {
  const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${CONSENT_COOKIE}=(granted|denied)`));
  return (m?.[1] as AnalyticsConsent | undefined) ?? null;
}

export function writeConsent(value: AnalyticsConsent) {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${CONSENT_COOKIE}=${value}; Path=/; Max-Age=${180 * 24 * 3600}; SameSite=Lax${secure}`;
  window.dispatchEvent(new CustomEvent<AnalyticsConsent>(CONSENT_EVENT, { detail: value }));
}
