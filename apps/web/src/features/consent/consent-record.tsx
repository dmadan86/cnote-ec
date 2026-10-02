"use client";

import { ConsentRecord as KitConsentRecord, useConsentId as useKitConsentId } from "@cnote/next-kit/consent";
import { CONSENT_COOKIE } from "./state";

/** The visitor's own consent id (null until a choice exists). Read from the cookie after mount, so static pages stay static. */
export const useConsentId = (): string | null | undefined => useKitConsentId(CONSENT_COOKIE);

/** "Your consent ID" + copy + download of the visitor's own record (GET /api/consent/receipt), bound to this app's cookie. */
export function ConsentRecord({ showEmpty = false, className }: { showEmpty?: boolean; className?: string }) {
  return <KitConsentRecord cookieName={CONSENT_COOKIE} downloadHref="/api/consent/receipt" showEmpty={showEmpty} className={className} />;
}
