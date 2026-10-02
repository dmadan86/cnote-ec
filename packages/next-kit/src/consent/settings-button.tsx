"use client";

import { openConsentPreferences } from "@cnote/consent/client";

/** Opens the cookie preferences dialog without a reload (footer, cookie policy page, account). `label` is the translated text. */
export function CookieSettingsButton({ label, className }: { label: string; className?: string }) {
  return (
    <button type="button" className={className} onClick={openConsentPreferences}>
      {label}
    </button>
  );
}
