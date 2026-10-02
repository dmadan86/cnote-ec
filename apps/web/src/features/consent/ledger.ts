// Account ledger sync (server). A signed-in person's cookie choice is mirrored into the identity consent ledger
// (purposes analytics_cookies / marketing_cookies) so it follows them across devices. Uses identity's PUBLIC functions only.
import { getConsentStates, setConsent, type ConsentLedgerState } from "@cnote/identity";
import type { AccountConsent } from "./account-sync";
import type { ConsentChoices } from "./state";

const SOURCE = "web_cookie_banner";
/** The cookie carries a client clock; within this skew of the server clock it is treated as "now". */
const SKEW_MS = 5 * 60_000;

/**
 * When the choice really happened, on the server clock. A fresh choice (client time within 5 minutes of now, the same
 * tolerance parseConsent allows) counts as now, so a slow or fast device clock cannot make a new choice look older than the
 * previous ledger row. A late resend of an offline receipt keeps its (older) client time, so it cannot overwrite a newer
 * choice made on another device meanwhile.
 */
export function effectiveChoiceTime(clientAtSeconds: number | undefined, nowMs: number): number {
  if (!clientAtSeconds) return nowMs;
  const clientMs = clientAtSeconds * 1000;
  return Math.abs(nowMs - clientMs) <= SKEW_MS ? nowMs : clientMs;
}

/**
 * Writes the ledger rows that changed. Per purpose: first ever -> write; different from the latest row AND newer than it
 * -> write; otherwise nothing (same value, or an older receipt arriving late). Returns the purposes written.
 */
export async function syncCookieConsentToLedger(personId: string, choices: ConsentChoices, o: { clientAt?: number; now?: number } = {}): Promise<string[]> {
  const now = o.now ?? Date.now();
  const at = effectiveChoiceTime(o.clientAt, now);
  const states = await getConsentStates(personId, ["analytics_cookies", "marketing_cookies"] as const);
  const wanted = [["analytics_cookies", choices.analytics], ["marketing_cookies", choices.marketing]] as const;
  const written: string[] = [];
  for (const [purpose, granted] of wanted) {
    const cur = states[purpose];
    if (!cur || (cur.granted !== granted && at > cur.at.getTime())) {
      await setConsent(personId, purpose, granted, SOURCE);
      written.push(purpose);
    }
  }
  return written;
}

const toLedger = (s: ConsentLedgerState | null) => (s ? { granted: s.granted, at: Math.floor(s.at.getTime() / 1000) } : null);

/** Body of GET /api/consent/account for a signed-in person. */
export async function loadAccountConsent(personId: string): Promise<AccountConsent> {
  const s = await getConsentStates(personId, ["analytics_cookies", "marketing_cookies"] as const);
  return { signedIn: true, analytics: toLedger(s.analytics_cookies), marketing: toLedger(s.marketing_cookies) };
}
