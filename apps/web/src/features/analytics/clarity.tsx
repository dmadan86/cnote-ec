"use client";

import { useEffect } from "react";
import { CONSENT_EVENT, readConsent, type AnalyticsConsent } from "./consent";

type ClarityFn = ((...args: unknown[]) => void) & { q?: unknown[][] };
declare global {
  interface Window {
    clarity?: ClarityFn;
  }
}

/**
 * Microsoft Clarity, loaded only after analytics consent. Clarity masks form inputs by default;
 * sensitive regions can opt in to masking with `data-clarity-mask="true"`. We never call
 * clarity("identify") with personal data.
 */
export function Clarity({ projectId }: { projectId: string }) {
  useEffect(() => {
    const load = () => {
      if (window.clarity) {
        window.clarity("consentv2", { ad_Storage: "denied", analytics_Storage: "granted" });
        return;
      }
      const c: ClarityFn = (...args: unknown[]) => {
        (c.q ??= []).push(args);
      };
      window.clarity = c;
      const s = document.createElement("script");
      s.async = true;
      s.src = `https://www.clarity.ms/tag/${encodeURIComponent(projectId)}`;
      document.head.appendChild(s);
      c("consentv2", { ad_Storage: "denied", analytics_Storage: "granted" });
    };
    const revoke = () => window.clarity?.("consentv2", { ad_Storage: "denied", analytics_Storage: "denied" });

    if (readConsent(document.cookie) === "granted") load();
    const onChange = (e: Event) => ((e as CustomEvent<AnalyticsConsent>).detail === "granted" ? load() : revoke());
    window.addEventListener(CONSENT_EVENT, onChange);
    return () => window.removeEventListener(CONSENT_EVENT, onChange);
  }, [projectId]);

  return null;
}
