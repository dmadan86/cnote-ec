// Account ledger sync (server) for the seller app, the same mechanism as the buyer web (apps/web/src/features/consent/ledger.ts,
// docs/design/cookie-consent.md "Account sync"): a signed-in seller's cookie choice is mirrored into the identity consent ledger so it
// follows the person across devices. The seller's optional storage (onboarding timing, referral attribution) is a different purpose
// from the buyer web's analytics/marketing cookies, so it has its OWN ledger purposes (seller_analytics_cookies /
// seller_marketing_cookies); one app's choice never changes what the other app is allowed to do. Uses identity's PUBLIC functions only.
import { effectiveChoiceTime, type AccountConsent } from "@cnote/consent";
import { getConsentStates, setConsent, SELLER_COOKIE_CONSENT_PURPOSES, type ConsentLedgerState } from "@cnote/identity";

const SOURCE = "seller_cookie_banner";

/**
 * Writes the ledger rows that changed. Per purpose: first ever -> write; different from the latest row AND newer than it
 * -> write; otherwise nothing (same value, or an older receipt arriving late). Returns the purposes written.
 */
export async function syncSellerCookieConsentToLedger(personId: string, choices: { analytics: boolean; marketing: boolean }, o: { clientAt?: number; now?: number } = {}): Promise<string[]> {
  const now = o.now ?? Date.now();
  const at = effectiveChoiceTime(o.clientAt, now);
  const states = await getConsentStates(personId, SELLER_COOKIE_CONSENT_PURPOSES);
  const wanted = [["seller_analytics_cookies", choices.analytics], ["seller_marketing_cookies", choices.marketing]] as const;
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

/** Body of GET /api/consent/account for a signed-in seller (no `functional`: the seller offers no such switch). */
export async function loadSellerAccountConsent(personId: string): Promise<AccountConsent> {
  const s = await getConsentStates(personId, SELLER_COOKIE_CONSENT_PURPOSES);
  return { signedIn: true, analytics: toLedger(s.seller_analytics_cookies), marketing: toLedger(s.seller_marketing_cookies), functional: null };
}
