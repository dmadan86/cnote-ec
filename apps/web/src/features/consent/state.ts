// Consent record (pure: no window/document/next imports, so route handlers, the proxy and client islands share it).
//
// The record lives in ONE first-party cookie, `cnote_consent`, holding a URL-encoded query string:
//   v=3&id=<32 hex>&a=1&m=0&f=0&t=<unix seconds>&gpc=0
// v = CONSENT_POLICY_VERSION, id = random consent id (links the receipt stored server-side), a = analytics,
// m = marketing and attribution, f = preferences & personalisation (functional; GPC does not affect it), t = when the choice was made, gpc = Global Privacy Control was on.
// Strictly necessary storage needs no consent (DPDP s.7(a)/(b); ePrivacy Art 5(3) exemptions) so it has no flag.
// Design + standards: docs/design/cookie-consent.md.

export const CONSENT_COOKIE = "cnote_consent";
/** Fired on `window` after every change; `detail` is the new ConsentState. */
export const CONSENT_EVENT = "cnote:consent";
/** Fired on `window` to open the preferences dialog (footer, policy page, account). */
export const CONSENT_OPEN_EVENT = "cnote:consent-open";

/**
 * Bump when a NEW non-essential purpose or provider is added, or an existing one changes materially: every stored
 * choice with an older version is treated as "no choice" and everybody is asked again (fresh, specific consent).
 */
export const CONSENT_POLICY_VERSION = 3;
/** Shown on the cookie policy page. Update together with CONSENT_POLICY_VERSION. */
export const CONSENT_POLICY_UPDATED = "2026-10-02";

/** 12 months. Re-prompt after this; stays under CNIL's 13-month maximum for the lifetime of a consent choice. */
export const CONSENT_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export const OPTIONAL_CATEGORIES = ["analytics", "marketing", "functional"] as const;
export type OptionalCategory = (typeof OPTIONAL_CATEGORIES)[number];
export type ConsentAction = "accept_all" | "reject_all" | "custom" | "withdraw";
export const CONSENT_ACTIONS: readonly ConsentAction[] = ["accept_all", "reject_all", "custom", "withdraw"];

export interface ConsentChoices {
  analytics: boolean;
  marketing: boolean;
  /** Preferences & personalisation (e.g. recently viewed). Not affected by Global Privacy Control. */
  functional: boolean;
}

export interface ConsentState extends ConsentChoices {
  version: number;
  /** random, 32 hex chars: identifies this browser's consent record (not a person). */
  id: string;
  /** Global Privacy Control signal was on when the choice was made. */
  gpc: boolean;
  /** unix seconds */
  at: number;
}

const ID_RE = /^[a-f0-9]{32}$/;
/** Tolerated clock skew between the browser that wrote the cookie and the reader. */
const SKEW_SECONDS = 300;

/**
 * The consent id inside a `cnote_consent` cookie VALUE, WITHOUT the version / age checks of parseConsent: a visitor whose
 * choice expired or whose policy version moved on can still look up and download the record of what they chose.
 */
export function consentIdFromCookieValue(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const id = new URLSearchParams(decodeURIComponent(raw)).get("id");
    return id && ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

export const isConsentId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);

export function newConsentId(): string {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const flag = (v: string | null): boolean | null => (v === "1" ? true : v === "0" ? false : null);

/**
 * Parses a `cnote_consent` cookie VALUE. Returns null (= "no valid choice, ask again") for anything that is missing,
 * malformed, from another policy version, older than 12 months, or in the future. The legacy values `granted` /
 * `denied` are therefore re-prompted. Accepts the raw or the already-decoded value.
 */
export function parseConsent(raw: string | null | undefined, now: number = Date.now()): ConsentState | null {
  if (!raw) return null;
  let text = raw;
  try {
    text = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!text.includes("=")) return null;
  const p = new URLSearchParams(text);
  const version = Number(p.get("v"));
  const id = p.get("id");
  const analytics = flag(p.get("a"));
  const marketing = flag(p.get("m"));
  // `f` (functional) is absent from cookies written before it existed: that means "not granted", never an error.
  const functional = p.get("f") === "1";
  if (p.has("f") && flag(p.get("f")) === null) return null;
  const gpc = flag(p.get("gpc"));
  const at = Number(p.get("t"));
  if (version !== CONSENT_POLICY_VERSION) return null;
  if (!isConsentId(id) || analytics === null || marketing === null || gpc === null) return null;
  if (!Number.isInteger(at) || at <= 0) return null;
  const nowS = Math.floor(now / 1000);
  if (at > nowS + SKEW_SECONDS || nowS - at > CONSENT_MAX_AGE_SECONDS) return null;
  return { version, id, analytics, marketing, functional, gpc, at };
}

/** Cookie VALUE for a state (URL-encoded query string). */
export function serializeConsent(s: ConsentState): string {
  const p = new URLSearchParams();
  p.set("v", String(s.version));
  p.set("id", s.id);
  p.set("a", s.analytics ? "1" : "0");
  p.set("m", s.marketing ? "1" : "0");
  p.set("f", s.functional ? "1" : "0");
  p.set("t", String(s.at));
  p.set("gpc", s.gpc ? "1" : "0");
  return encodeURIComponent(p.toString());
}

/** Full `Set-Cookie` / `document.cookie` string. Readable by client code on purpose (islands react to it). */
export function consentCookieString(s: ConsentState, secure: boolean): string {
  return `${CONSENT_COOKIE}=${serializeConsent(s)}; Path=/; Max-Age=${CONSENT_MAX_AGE_SECONDS}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Value of a named cookie in a `Cookie` / `document.cookie` header, or undefined. */
export function cookieValue(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** Consent state from a `Cookie` request header / `document.cookie` string. */
export const readConsentFromHeader = (header: string | null | undefined, now?: number): ConsentState | null =>
  parseConsent(cookieValue(header, CONSENT_COOKIE), now);

export const isGranted = (s: ConsentState | null | undefined, category: OptionalCategory): boolean => !!s && s[category];

/** Server helper: marketing storage (`cnote_vid`, `cnote_ad_click`) may only be set when this is true. */
export const marketingGrantedInHeader = (header: string | null | undefined, now?: number): boolean => isGranted(readConsentFromHeader(header, now), "marketing");

/** What "Accept all" grants: everything, except marketing when the Global Privacy Control signal is on. */
export const acceptAllChoices = (gpc: boolean): ConsentChoices => ({ analytics: true, marketing: !gpc, functional: true });
export const REJECT_ALL: ConsentChoices = { analytics: false, marketing: false, functional: false };

/**
 * The action to record: a choice that switches off something previously granted is a `withdraw`, whichever button was
 * used, so the receipt log shows withdrawals distinctly.
 */
export function deriveAction(requested: Exclude<ConsentAction, "withdraw">, prev: ConsentState | null, next: ConsentChoices): ConsentAction {
  if (requested === "accept_all") return requested;
  const withdrew = !!prev && OPTIONAL_CATEGORIES.some((c) => prev[c] && !next[c]);
  return withdrew ? "withdraw" : requested;
}

export function buildConsent(
  choices: ConsentChoices,
  o: { gpc: boolean; prev?: ConsentState | null; now?: number; /** unix seconds; overrides the clock (account sync adopts the ledger's time) */ at?: number },
): ConsentState {
  // `at` is strictly increasing per consent id: the server dedupes receipts on (id, at), so two different choices must
  // never share a second (a double click, a scripted test).
  const stamp = o.at ?? Math.floor((o.now ?? Date.now()) / 1000);
  const at = o.prev && stamp <= o.prev.at ? o.prev.at + 1 : stamp;
  return {
    version: CONSENT_POLICY_VERSION,
    id: o.prev?.id ?? newConsentId(),
    analytics: choices.analytics,
    marketing: choices.marketing,
    functional: choices.functional,
    gpc: o.gpc,
    at,
  };
}

/** True while there is no valid choice (first visit, expired, legacy value or a new policy version). */
export const needsPrompt = (s: ConsentState | null): boolean => s === null;
