// First-party anonymous visitor id + first-touch attribution. No PII, but this is MARKETING-category storage
// (features/consent/registry.ts): nothing is written to cookies/sessionStorage and no UTM/referrer is captured unless the
// visitor granted "marketing" (DPDP s.6; ePrivacy Art 5(3)). Without consent the id is ephemeral (in memory, gone on reload)
// so the lead flow keeps working. Client-only helpers: call from effects/handlers, never during render or on the server.
import type { Attribution } from "@cnote/leadgen";
import { clientGranted } from "@/features/consent/client";

const COOKIE = "cnote_vid";
const ATTR_KEY = "cnote_attr";

const rand = () => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};

let ephemeralId: string | null = null;

export function getVisitorId(): string {
  try {
    if (!clientGranted("marketing")) return (ephemeralId ??= `v${rand()}`);
    const m = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([A-Za-z0-9_-]{8,64})`));
    if (m?.[1]) return m[1];
    const id = `v${rand()}`;
    document.cookie = `${COOKIE}=${id}; Max-Age=${60 * 60 * 24 * 30}; Path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
    return id;
  } catch {
    return `v${rand()}`;
  }
}

const deviceOf = (): Attribution["device"] => (matchMedia("(max-width: 767px)").matches ? "mobile" : matchMedia("(max-width: 1023px)").matches ? "tablet" : "desktop");

/** Records UTM/referrer/landing path once per session (first touch wins); returns the stored value. */
export function captureAttribution(): Attribution {
  try {
    // No marketing consent: nothing stored, and no campaign/referrer data collected. Only the page and device class.
    if (!clientGranted("marketing")) return { landingPath: location.pathname.slice(0, 300), device: deviceOf() };
    const hit = sessionStorage.getItem(ATTR_KEY);
    if (hit) return JSON.parse(hit) as Attribution;
    const q = new URLSearchParams(location.search);
    const a: Attribution = { landingPath: location.pathname.slice(0, 300), device: deviceOf() };
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const) {
      const v = q.get(k);
      if (v) a[k] = v.slice(0, 150);
    }
    if (document.referrer) {
      try {
        const r = new URL(document.referrer);
        if (r.origin !== location.origin) a.referrer = `${r.origin}${r.pathname}`.slice(0, 300);
      } catch {
        /* ignore malformed referrer */
      }
    }
    sessionStorage.setItem(ATTR_KEY, JSON.stringify(a));
    return a;
  } catch {
    return {};
  }
}
