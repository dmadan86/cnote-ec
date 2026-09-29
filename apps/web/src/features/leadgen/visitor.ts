// First-party anonymous visitor id + first-touch attribution. No PII; the cookie is functional (funnel stitching),
// not advertising. Client-only helpers: call from effects/handlers, never during render or on the server.
import type { Attribution } from "@cnote/leadgen";

const COOKIE = "cnote_vid";
const ATTR_KEY = "cnote_attr";

const rand = () => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};

export function getVisitorId(): string {
  try {
    const m = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([A-Za-z0-9_-]{8,64})`));
    if (m?.[1]) return m[1];
    const id = `v${rand()}`;
    document.cookie = `${COOKIE}=${id}; Max-Age=${60 * 60 * 24 * 365}; Path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
    return id;
  } catch {
    return `v${rand()}`;
  }
}

const deviceOf = (): Attribution["device"] => (matchMedia("(max-width: 767px)").matches ? "mobile" : matchMedia("(max-width: 1023px)").matches ? "tablet" : "desktop");

/** Records UTM/referrer/landing path once per session (first touch wins); returns the stored value. */
export function captureAttribution(): Attribution {
  try {
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
