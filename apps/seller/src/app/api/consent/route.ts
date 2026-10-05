import { recordCookieConsent } from "@cnote/compliance";
import { currentSession } from "@cnote/next-kit";
import { createConsentPost } from "@cnote/next-kit/consent-route";
import { syncSellerCookieConsentToLedger } from "@/features/consent/ledger";
import { sellerRegistryHashFor } from "@/features/consent/policy";
import { SELLER_STORAGE_REGISTRY } from "@/features/consent/registry";

// Cookie-consent receipt + server-side withdrawal for the SELLER app (DPDP s.6(10); docs/design/cookie-consent.md, "Other apps").
// The handler is shared with the buyer web (@cnote/next-kit/consent-route). Receipts go to the same compliance table with
// app = "seller" and this app's committed policy snapshot hash; withdrawing a category expires its httpOnly cookies
// (seller_onb_t0 / seller_onb_t1 for analytics, seller_ref for marketing), which the browser cannot delete itself.
// Account sync (same as the buyer web): a signed-in seller's choice is mirrored into the identity consent ledger
// (seller_analytics_cookies / seller_marketing_cookies) so it follows the seller across devices; GET /api/consent/account reads it back.
export const dynamic = "force-dynamic";

export const POST = createConsentPost({
  app: "seller",
  logTag: "[seller]",
  getSession: () => currentSession(),
  record: (input, ctx) => recordCookieConsent(input, ctx),
  registryHashFor: sellerRegistryHashFor,
  registry: SELLER_STORAGE_REGISTRY,
  onSaved: (input, session) => {
    if (typeof input.analytics !== "boolean" || typeof input.marketing !== "boolean") return Promise.resolve();
    return syncSellerCookieConsentToLedger(session.personId, { analytics: input.analytics, marketing: input.marketing }, { clientAt: typeof input.at === "number" ? input.at : undefined });
  },
});
