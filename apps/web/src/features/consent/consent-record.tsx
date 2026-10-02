"use client";

import { buttonClasses } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { consentSnapshot, subscribeConsent } from "./client";
import { consentIdFromCookieValue } from "./state";

/** The visitor's own consent id (null until a choice exists). Read from the cookie after mount, so static pages stay static. */
export function useConsentId(): string | null | undefined {
  // undefined = server / hydrating, null = no record yet
  const raw = useSyncExternalStore(subscribeConsent, consentSnapshot, () => null);
  return raw === null ? undefined : consentIdFromCookieValue(raw);
}

const ACTION = buttonClasses("outline-brand", "md", "min-h-11");

/**
 * "Your consent ID: …" with a copy button (confirmation announced through a polite live region) and a download of the
 * visitor's own consent history (GET /api/consent/receipt). DPDP s.6(10) / GDPR Art 7(1): the person can see and take
 * the proof, and quote the ID to the Grievance Officer. `showEmpty` renders a hint when no choice exists yet.
 */
export function ConsentRecord({ showEmpty = false, className }: { showEmpty?: boolean; className?: string }) {
  const t = useTranslations("consent");
  const id = useConsentId();
  const [status, setStatus] = useState<"" | "copied" | "failed">("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const announce = (s: "copied" | "failed") => {
    setStatus(s);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(""), 5000);
  };
  const copy = async () => {
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      announce("copied");
    } catch {
      announce("failed");
    }
  };

  return (
    <div className={className} data-testid="consent-record">
      {id ? (
        <>
          <p className="text-sm text-ink">
            <span className="font-semibold">{t("consentIdLabel")}</span>{" "}
            <code data-testid="consent-id" className="break-all rounded bg-canvas px-1.5 py-0.5 font-mono text-[0.8125rem]">{id}</code>
          </p>
          <p className="mt-1 text-sm text-muted">{t("consentIdHelp")}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className={ACTION} onClick={() => void copy()}>
              {t("copyId")}
            </button>
            <a href="/api/consent/receipt" download className={ACTION}>
              {t("downloadRecord")}
            </a>
          </div>
        </>
      ) : showEmpty && id === null ? (
        <p className="text-sm text-muted">{t("noChoiceYet")}</p>
      ) : null}
      {/* Always mounted so assistive tech registers the region before its text changes. */}
      <p role="status" aria-live="polite" className="mt-2 min-h-5 text-sm font-medium text-ink">
        {status === "copied" ? t("idCopied") : status === "failed" ? t("idCopyFailed") : ""}
      </p>
    </div>
  );
}
