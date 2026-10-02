import { recordCookieConsent } from "@cnote/compliance";
import { currentSession } from "@cnote/next-kit";
import { createConsentPost } from "@cnote/next-kit/consent-route";
import { syncCookieConsentToLedger } from "@/features/consent/ledger";
import { registryHashFor } from "@/features/consent/policy";
import { STORAGE_REGISTRY } from "@/features/consent/registry";

// Cookie-consent receipt + server-side withdrawal (DPDP s.6(10) proof of consent; docs/design/cookie-consent.md).
// The handler is shared with the seller app (@cnote/next-kit/consent-route); this file binds it to the buyer web:
//  - receipts are written with app = "web" and the web's committed policy snapshot hash;
//  - a signed-in person's choice is mirrored into the identity consent ledger (analytics_cookies / marketing_cookies /
//    functional_cookies) so it follows the person across devices; the newer of ledger and receipt wins per purpose;
//  - when marketing is not granted, the httpOnly cookies the browser cannot delete (cnote_vid, cnote_ad_click) are expired.
export const dynamic = "force-dynamic";

export const POST = createConsentPost({
  app: "web",
  logTag: "[web]",
  getSession: () => currentSession(),
  record: (input, ctx) => recordCookieConsent(input, ctx),
  registryHashFor,
  registry: STORAGE_REGISTRY,
  onSaved: (input, session) => {
    if (typeof input.analytics !== "boolean" || typeof input.marketing !== "boolean") return Promise.resolve();
    const functional = input.functional === true; // absent (an older queued receipt) means not granted
    return syncCookieConsentToLedger(session.personId, { analytics: input.analytics, marketing: input.marketing, functional }, { clientAt: typeof input.at === "number" ? input.at : undefined });
  },
});
