"use client";

import { useLocale } from "next-intl";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ConsentBannerView } from "./banner";
import { acceptAll, applyConsent, consentSnapshot, flushPendingReceipts, gpcSignal, rejectAll, subscribeConsent, syncFromAccount } from "./client";
import { PreferencesDialog } from "./preferences-dialog";
import { CONSENT_OPEN_EVENT, parseConsent, type ConsentChoices } from "./state";

const noopSubscribe = () => () => undefined;

/**
 * Mount once per page chrome (via <Analytics />). Reads the consent cookie AFTER hydration (the public pages are static, so
 * the server cannot know), so nothing renders on the server and there is no hydration mismatch. The banner is `fixed`, so
 * it never shifts page content; while it is shown `<html data-consent-banner>` + `--consent-banner-h` add bottom padding and
 * scroll-padding so the footer stays reachable and a focused control is never hidden behind it (WCAG 2.4.11).
 */
export function ConsentManager() {
  const locale = useLocale();
  // null = server / hydrating (unknown); "" = no cookie; otherwise the raw cookie value.
  const raw = useSyncExternalStore(subscribeConsent, consentSnapshot, () => null);
  const gpc = useSyncExternalStore(noopSubscribe, gpcSignal, () => false);
  const consent = raw ? parseConsent(raw) : null;
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const customiseRef = useRef<HTMLButtonElement>(null);
  const bannerRef = useRef<HTMLElement>(null);
  const showBanner = raw !== null && consent === null;

  // Reliable receipts: resend any receipt the server has not acknowledged yet (idempotent on consentId + at), then, for
  // signed-in people, reconcile the cookie with the account ledger. Both run once per page load; neither blocks rendering.
  useEffect(() => {
    void flushPendingReceipts().then(() => syncFromAccount(locale));
  }, [locale]);

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
    applyConsent(choices, "custom", locale);
    close();
  };

  return (
    <>
      {showBanner ? (
        <ConsentBannerView
          bannerRef={bannerRef}
          customiseRef={customiseRef}
          hidden={open}
          onAccept={() => void acceptAll(locale)}
          onReject={() => void rejectAll(locale)}
          onCustomise={() => {
            opener.current = customiseRef.current;
            setOpen(true);
          }}
        />
      ) : null}
      <PreferencesDialog
        open={open}
        onClose={close}
        initial={consent}
        gpc={gpc}
        onAcceptAll={() => {
          acceptAll(locale);
          close();
        }}
        onRejectAll={() => {
          rejectAll(locale);
          close();
        }}
        onSave={onSave}
      />
    </>
  );
}
