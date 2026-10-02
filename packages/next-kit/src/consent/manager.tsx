"use client";

import { CONSENT_OPEN_EVENT, parseConsent, type ConsentChoices } from "@cnote/consent";
import { acceptAll, applyConsent, consentSnapshot, flushPendingReceipts, gpcSignal, rejectAll, subscribeConsent, type ConsentConfig } from "@cnote/consent/client";
import { useLocale } from "next-intl";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ConsentBannerView } from "./banner";
import { PreferencesDialog } from "./preferences-dialog";

const noopSubscribe = () => () => undefined;

export interface ConsentManagerProps {
  /** the app's consent config (cookie name, policy version, registry, storage keys, receipt path) */
  config: ConsentConfig;
  /** the data fiduciary's name in the banner and dialog */
  siteName: string;
  /** wraps the `<link>` chunk of `consent.bannerText` (cookie policy link); omit when the app's text has none */
  policyLink?: (chunks: ReactNode) => ReactNode;
  /** an extra sentence under the dialog intro */
  note?: ReactNode;
  /** consent ID + record download shown in the dialog once a choice exists, when the app offers them */
  record?: ReactNode;
  /** runs once per page load after unacknowledged receipts were resent (the buyer web reconciles with the account ledger here) */
  afterFlush?: (locale: string) => Promise<unknown>;
}

/**
 * Mount once per page chrome. Reads the consent cookie AFTER hydration (static pages cannot know it on the server), so nothing
 * renders on the server and there is no hydration mismatch. The banner is `fixed`, so it never shifts page content; while it is
 * shown `<html data-consent-banner>` + `--consent-banner-h` add bottom padding and scroll-padding so the footer stays reachable and
 * a focused control is never hidden behind it (WCAG 2.4.11). Shared by the buyer web and the seller app (docs/design/cookie-consent.md).
 */
export function ConsentManager({ config, siteName, policyLink, note, record, afterFlush }: ConsentManagerProps) {
  const locale = useLocale();
  // null = server / hydrating (unknown); "" = no cookie; otherwise the raw cookie value.
  const raw = useSyncExternalStore(subscribeConsent, () => consentSnapshot(config), () => null);
  const gpc = useSyncExternalStore(noopSubscribe, gpcSignal, () => false);
  const consent = raw ? parseConsent(raw, config.policyVersion) : null;
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const customiseRef = useRef<HTMLButtonElement>(null);
  const bannerRef = useRef<HTMLElement>(null);
  const showBanner = raw !== null && consent === null;

  // Reliable receipts: resend any receipt the server has not acknowledged yet (idempotent on consentId + at), then run the app's
  // follow-up. Once per page load; never blocks rendering.
  useEffect(() => {
    void flushPendingReceipts(config).then(() => afterFlush?.(locale));
  }, [config, locale, afterFlush]);

  useEffect(() => {
    const onOpen = () => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true);
    };
    window.addEventListener(CONSENT_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(CONSENT_OPEN_EVENT, onOpen);
  }, []);

  useEffect(() => {
    const el = bannerRef.current;
    if (!showBanner || !el) return;
    const root = document.documentElement;
    root.setAttribute("data-consent-banner", "");
    const size = () => root.style.setProperty("--consent-banner-h", `${el.offsetHeight}px`);
    size();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(size);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.removeAttribute("data-consent-banner");
      root.style.removeProperty("--consent-banner-h");
    };
  }, [showBanner]);

  const close = useCallback(() => {
    setOpen(false);
    const back = opener.current;
    opener.current = null;
    // The browser returns focus to the opener itself, except when it was hidden while the dialog was open (banner button).
    if (back) requestAnimationFrame(() => back.isConnected && back.focus());
  }, []);

  const onSave = (choices: ConsentChoices) => {
    applyConsent(config, choices, "custom", locale);
    close();
  };

  return (
    <>
      {showBanner ? (
        <ConsentBannerView
          siteName={siteName}
          policyLink={policyLink}
          bannerRef={bannerRef}
          customiseRef={customiseRef}
          hidden={open}
          onAccept={() => void acceptAll(config, locale)}
          onReject={() => void rejectAll(config, locale)}
          onCustomise={() => {
            opener.current = customiseRef.current;
            setOpen(true);
          }}
        />
      ) : null}
      <PreferencesDialog
        registry={config.registry}
        siteName={siteName}
        note={note}
        record={record}
        open={open}
        onClose={close}
        initial={consent}
        gpc={gpc}
        onAcceptAll={() => {
          acceptAll(config, locale);
          close();
        }}
        onRejectAll={() => {
          rejectAll(config, locale);
          close();
        }}
        onSave={onSave}
      />
    </>
  );
}
