import { recordCookieConsent } from "@cnote/compliance";
import { currentSession } from "@cnote/next-kit";
import { createConsentPost } from "@cnote/next-kit/consent-route";
import { sellerRegistryHashFor } from "@/features/consent/policy";
import { SELLER_STORAGE_REGISTRY } from "@/features/consent/registry";

// Cookie-consent receipt + server-side withdrawal for the SELLER app (DPDP s.6(10); docs/design/cookie-consent.md, "Other apps").
// The handler is shared with the buyer web (@cnote/next-kit/consent-route). Receipts go to the same compliance table with
// app = "seller" and this app's committed policy snapshot hash; withdrawing a category expires its httpOnly cookies
// (seller_onb_t0 / seller_onb_t1 for analytics, seller_ref for marketing), which the browser cannot delete itself.
// There is no account-ledger sync here: the buyer web mirrors choices into the identity ledger; a seller's choice is per device.
export const dynamic = "force-dynamic";

export const POST = createConsentPost({
  app: "seller",
  logTag: "[seller]",
  getSession: () => currentSession(),
  record: (input, ctx) => recordCookieConsent(input, ctx),
  registryHashFor: sellerRegistryHashFor,
  registry: SELLER_STORAGE_REGISTRY,
});
