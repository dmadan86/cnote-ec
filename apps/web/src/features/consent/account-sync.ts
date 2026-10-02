// Account sync (pure part): decides whether the browser's cookie choice should be replaced by the signed-in person's
// consent ledger (identity `analytics_cookies` / `marketing_cookies`), so a choice follows the person across devices.
// Rule: per purpose, the NEWER of cookie and ledger wins, so a withdrawal on one device beats an older grant on another.
// The ledger is written by POST /api/consent (server) when a signed-in person saves a choice. See docs/design/cookie-consent.md.
import { CONSENT_MAX_AGE_SECONDS, type ConsentChoices, type ConsentState } from "./state";

export interface LedgerState {
  granted: boolean;
  /** unix seconds the ledger row was written (server clock) */
  at: number;
}

/** Body of GET /api/consent/account. */
export interface AccountConsent {
  signedIn: boolean;
  analytics: LedgerState | null;
  marketing: LedgerState | null;
}

export type SyncDecision = { kind: "none" } | { kind: "adopt"; choices: ConsentChoices; at: number };

const NONE: SyncDecision = { kind: "none" };

export function reconcileAccountConsent(cookie: ConsentState | null, account: AccountConsent | null, nowSeconds: number): SyncDecision {
  if (!account?.signedIn) return NONE;
  const { analytics, marketing } = account;
  if (!analytics && !marketing) return NONE;
  if (!cookie) {
    // No valid cookie (new device, expired, new policy version): seed from the ledger, unless it is itself too old to rely on.
    const at = Math.max(analytics?.at ?? 0, marketing?.at ?? 0);
    if (nowSeconds - at > CONSENT_MAX_AGE_SECONDS) return NONE;
    return { kind: "adopt", choices: { analytics: analytics?.granted ?? false, marketing: marketing?.granted ?? false }, at };
  }
  // A valid cookie exists: take a ledger value only where it is newer than the cookie AND different.
  const choices: ConsentChoices = { analytics: cookie.analytics, marketing: cookie.marketing };
  let at = 0;
  for (const [key, ledger] of [["analytics", analytics], ["marketing", marketing]] as const) {
    if (ledger && ledger.at > cookie.at && ledger.granted !== cookie[key]) {
      choices[key] = ledger.granted;
      at = Math.max(at, ledger.at);
    }
  }
  return at > 0 ? { kind: "adopt", choices, at } : NONE;
}

/** The action to record for an adopted choice set (the receipt log shows where it came from through the action + policy). */
export const requestedActionFor = (c: ConsentChoices): "accept_all" | "reject_all" | "custom" => (c.analytics && c.marketing ? "accept_all" : !c.analytics && !c.marketing ? "reject_all" : "custom");
