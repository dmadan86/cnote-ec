"use client";

import { Button } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { readConsent, writeConsent } from "./consent";

/** Shown until the visitor chooses. Reject is as prominent as accept (no dark patterns). */
export function ConsentBanner() {
  const t = useTranslations("consent");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    // Cookie is only readable after hydration; showing the banner post-mount avoids a mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(readConsent(document.cookie) === null);
  }, []);
  if (!open) return null;

  const choose = (v: "granted" | "denied") => {
    writeConsent(v);
    setOpen(false);
  };

  return (
    <div role="dialog" aria-live="polite" aria-label={t("aria")} className="fixed inset-x-0 bottom-0 z-50 p-4 sm:p-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 rounded-card border border-line bg-surface p-4 shadow-lg sm:flex-row sm:items-center">
        <p className="text-sm text-ink">
          {t("text")}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" onClick={() => choose("denied")}>
            {t("reject")}
          </Button>
          <Button size="sm" onClick={() => choose("granted")}>
            {t("accept")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Footer link to reopen the choice. */
export function ManageConsentLink({ className }: { className?: string }) {
  const t = useTranslations("shell.footer");
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        document.cookie = "cnote_consent=; Path=/; Max-Age=0";
        location.reload();
      }}
    >
      {t("cookiePrefs")}
    </button>
  );
}
