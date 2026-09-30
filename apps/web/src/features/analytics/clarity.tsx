"use client";

import { useEffect } from "react";
import { clearCategoryStorage, readClientConsent } from "@/features/consent/client";
import { CONSENT_EVENT, isGranted, type ConsentState } from "@/features/consent/state";

type ClarityFn = ((...args: unknown[]) => void) & { q?: unknown[][] };
declare global {
  interface Window {
    clarity?: ClarityFn;
  }
}

/**
 * Microsoft Clarity, loaded only after analytics consent (DPDP s.6; ePrivacy Art 5(3)). `ad_Storage` follows the
 * separate marketing choice. On withdrawal Clarity is told `consentv2` denied (it stops recording and drops its cookies),
 * its `_clck`/`_clsk` cookies are expired, and the script is never loaded again until a new opt-in. Clarity masks form
 * inputs by default; sensitive regions can opt in to masking with `data-clarity-mask="true"`. We never call
 * clarity("identify") with personal data.
 */
export function Clarity({ projectId }: { projectId: string }) {
  useEffect(() => {
    const load = (ad: boolean) => {
      const consent = { ad_Storage: ad ? "granted" : "denied", analytics_Storage: "granted" };
      if (window.clarity) {
        window.clarity("consentv2", consent);
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
      c("consentv2", consent);
    };
    const apply = (s: ConsentState | null) => {
      if (isGranted(s, "analytics")) {
        load(isGranted(s, "marketing"));
        return;
      }
      window.clarity?.("consentv2", { ad_Storage: "denied", analytics_Storage: "denied" });
      if (window.clarity) clearCategoryStorage("analytics"); // Clarity may have written after the manager's own cleanup
    };

    apply(readClientConsent());
    const onChange = (e: Event) => apply((e as CustomEvent<ConsentState>).detail);
    window.addEventListener(CONSENT_EVENT, onChange);
    return () => window.removeEventListener(CONSENT_EVENT, onChange);
  }, [projectId]);

  return null;
}
