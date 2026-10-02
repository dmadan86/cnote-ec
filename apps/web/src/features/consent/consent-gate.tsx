"use client";

import { buttonClasses } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { consentSnapshot, openConsentPreferences, subscribeConsent } from "./client";
import { isGranted, parseConsent, type OptionalCategory } from "./state";

export interface ConsentGateClasses {
  root?: string;
  /** "Load it" */
  primary?: string;
  /** "Change cookie settings" */
  secondary?: string;
}

const DEFAULT: Required<ConsentGateClasses> = {
  root: "flex flex-col items-start gap-3 rounded-card border border-line bg-canvas p-4 text-ink",
  primary: buttonClasses("primary", "md", "min-h-11"),
  secondary: buttonClasses("outline-brand", "md", "min-h-11"),
};

/** Is the gate open? `raw` is the consent cookie value (null while hydrating, "" without a cookie): only a valid grant of `category` opens it. */
export const gateOpen = (raw: string | null, category: OptionalCategory, now?: number): boolean => !!raw && isGranted(parseConsent(raw, now), category);

/** The gate's two faces: the loaded content, or the accessible placeholder. Presentational (no hooks of its own beyond ids), so it renders on the server and is unit-tested. */
export function GateView({
  open,
  provider,
  children,
  classes,
  onLoad,
  contentRef,
}: {
  open: boolean;
  provider: string;
  children: ReactNode;
  classes?: ConsentGateClasses;
  onLoad?: () => void;
  contentRef?: Ref<HTMLDivElement>;
}) {
  const t = useTranslations("consent");
  const labelId = useId();
  const c = { ...DEFAULT, ...classes };
  if (open) {
    return (
      <div ref={contentRef} tabIndex={-1} className="outline-none">
        {children}
      </div>
    );
  }
  return (
    <div role="group" aria-labelledby={labelId} data-consent-gate="" className={c.root}>
      <p id={labelId}>{t("gate.body", { provider })}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={c.primary} onClick={onLoad}>
          {t("gate.load")}
        </button>
        <button type="button" className={c.secondary} onClick={openConsentPreferences}>
          {t("gate.settings")}
        </button>
      </div>
      <p className="text-sm opacity-80">{t("gate.hint")}</p>
    </div>
  );
}

/**
 * Consent gate for third-party embeds (iframes, widgets): renders an accessible placeholder naming the provider until the visitor has
 * granted `category`, then renders `children`. Until then NOTHING of the provider is requested (no iframe, no cookie, no IP disclosure):
 * `children` is not even created by the browser (DPDP s.6; ePrivacy Art 5(3); docs/design/cookie-consent.md, "Consent gate").
 *
 *  - "Load it" shows THIS item for this page view only; it does not change the stored cookie choice. It is a specific, informed act by
 *    the visitor for one named provider.
 *  - "Change cookie settings" opens the preferences dialog; granting the category then loads every embed of that category live (the
 *    `cnote:consent` event), withdrawing it removes them again.
 *
 * The consent cookie is read after hydration (the pages are static), so the server and the first client render both show the
 * placeholder. Every third-party `<iframe>` in the apps must sit inside a ConsentGate (apps/web/test/consent-gate.test.ts enforces it).
 */
export function ConsentGate({ category, provider, children, classes }: { category: OptionalCategory; provider: string; children: ReactNode; classes?: ConsentGateClasses }) {
  // null = server / hydrating (unknown); "" = no cookie; otherwise the raw cookie value.
  const raw = useSyncExternalStore(subscribeConsent, consentSnapshot, () => null);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const clicked = useRef(false);

  // After the visitor's own click the focused button disappears; park focus on the loaded content so keyboard users are not dropped.
  useEffect(() => {
    if (loadedOnce && clicked.current) content.current?.focus();
  }, [loadedOnce]);

  return (
    <GateView
      open={loadedOnce || gateOpen(raw, category)}
      provider={provider}
      classes={classes}
      contentRef={content}
      onLoad={() => {
        clicked.current = true;
        setLoadedOnce(true);
      }}
    >
      {children}
    </GateView>
  );
}
