// Account ledger sync (server). A signed-in person's cookie choice is mirrored into the identity consent ledger
// (purposes analytics_cookies / marketing_cookies / functional_cookies) so it follows them across devices. Uses identity's PUBLIC functions only.
import { getConsentStates, setConsent, type ConsentLedgerState } from "@cnote/identity";
import { effectiveChoiceTime } from "@cnote/consent";
import type { AccountConsent } from "./account-sync";
import type { ConsentChoices } from "./state";

export { effectiveChoiceTime };

const SOURCE = "web_cookie_banner";
/**
 * Writes the ledger rows that changed. Per purpose: first ever -> write; different from the latest row AND newer than it
 * -> write; otherwise nothing (same value, or an older receipt arriving late). Returns the purposes written.
 */
export async function syncCookieConsentToLedger(personId: string, choices: ConsentChoices, o: { clientAt?: number; now?: number } = {}): Promise<string[]> {
  const now = o.now ?? Date.now();
  const at = effectiveChoiceTime(o.clientAt, now);
  const states = await getConsentStates(personId, ["analytics_cookies", "marketing_cookies", "functional_cookies"] as const);
  const wanted = [["analytics_cookies", choices.analytics], ["marketing_cookies", choices.marketing], ["functional_cookies", choices.functional]] as const;
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
  const s = await getConsentStates(personId, ["analytics_cookies", "marketing_cookies", "functional_cookies"] as const);
  return { signedIn: true, analytics: toLedger(s.analytics_cookies), marketing: toLedger(s.marketing_cookies), functional: toLedger(s.functional_cookies) };
}
