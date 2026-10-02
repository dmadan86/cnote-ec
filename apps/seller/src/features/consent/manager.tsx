"use client";

import { CONSENT_EVENT, type ConsentState } from "@cnote/consent";
import { ConsentManager } from "@cnote/next-kit/consent";
import { useEffect } from "react";
import { APP_NAME } from "@/lib/brand";
import { SELLER_CONSENT_CONFIG } from "./config";

const REF_RE = /^[A-Za-z0-9_-]{4,64}$/;

/**
 * A referral link (`?ref=CODE`, ADR-025) lands on a page BEFORE the visitor can answer the banner, and the proxy stores the code
 * only when marketing is already granted. When marketing is granted afterwards, hand the code from the address bar to the server so
 * the referrer is still credited. Nothing is stored without the grant; the code is validated again server side.
 */
function useCaptureReferralAfterConsent() {
  useEffect(() => {
    const onChange = (e: Event) => {
      const state = (e as CustomEvent<ConsentState>).detail;
      if (!state?.marketing) return;
      const ref = new URLSearchParams(window.location.search).get("ref");
      if (ref && REF_RE.test(ref)) void fetch("/api/consent/ref", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref }), credentials: "same-origin" }).catch(() => undefined);
    };
    window.addEventListener(CONSENT_EVENT, onChange);
    return () => window.removeEventListener(CONSENT_EVENT, onChange);
  }, []);
}

/** The seller app's banner + preferences dialog: the shared manager bound to the seller registry (docs/design/cookie-consent.md). */
export function SellerConsentManager() {
  useCaptureReferralAfterConsent();
  return <ConsentManager config={SELLER_CONSENT_CONFIG} siteName={APP_NAME} />;
}
