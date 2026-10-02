// Single source of truth for every cookie / browser-storage key the buyer web sets. The preferences dialog, the cookie
// policy page and the "consent-cleanup on withdrawal" all render from this list, and test/consent-registry.test.ts fails
// when code writes a `cnote_*` key that is missing here. Adding a key: docs/design/cookie-consent.md#adding-a-cookie.
//
// Categories (the user-facing consent purposes):
//   necessary  strictly necessary: sign-in/security, or something the user explicitly asked for (language, pincode,
//              rail toggle, compare tray, dismissing a banner). Exempt from consent (DPDP s.7; ePrivacy Art 5(3)).
//   analytics  Microsoft Clarity session analytics.
//   marketing  visitor id, ad-click + campaign attribution, lead-gen nudge history, "recently viewed" browsing history
//              (personalisation is not strictly necessary; a separate preferences category would change the consent
//              cookie, the receipt schema and the account ledger, so it rides on marketing for now: see docs/design/buyer-convenience.md).
import type { OptionalCategory } from "./state";

export type StorageCategory = "necessary" | OptionalCategory;
export type StorageKind = "cookie" | "localStorage" | "sessionStorage";
export type StorageProvider = "firstParty" | "clarity";
export type Duration = { unit: "session" } | { unit: "persistent" } | { unit: "minutes" | "days" | "months" | "years"; n: number };

export interface StorageEntry {
  /** cookie name or storage key, exactly as written by code */
  name: string;
  category: StorageCategory;
  kind: StorageKind;
  provider: StorageProvider;
  /** key under messages `consent.purpose.*` */
  purpose: string;
  duration: Duration;
  /** httpOnly cookies are set by the server and expired by POST /api/consent; client code cannot touch them */
  httpOnly?: boolean;
  /** Also written server-side as an httpOnly cookie of the same name (cnote_vid), so POST /api/consent expires it too. */
  alsoServerSet?: boolean;
}

const firstParty = (name: string, category: StorageCategory, kind: StorageKind, purpose: string, duration: Duration, httpOnly = false): StorageEntry => ({
  name, category, kind, provider: "firstParty", purpose, duration, ...(httpOnly ? { httpOnly } : {}),
});
const clarity = (name: string, purpose: string, duration: Duration): StorageEntry => ({ name, category: "analytics", kind: "cookie", provider: "clarity", purpose, duration });

export const STORAGE_REGISTRY: readonly StorageEntry[] = [
  // --- strictly necessary -------------------------------------------------------------------------------------------
  firstParty("cnote_consent", "necessary", "cookie", "consent", { unit: "months", n: 12 }),
  // Auth cookies carry a `__Host-` prefix in production (packages/identity cookieNames). httpOnly, set by the server.
  // The consent record itself, so strictly necessary (DPDP s.6(10) proof): the receipt not yet acknowledged by the server
  // (resent on the next load until it gets a 200, then deleted) and the once-per-visit "checked against your account" flag.
  firstParty("cnote_consent_pending", "necessary", "localStorage", "consentPending", { unit: "persistent" }),
  firstParty("cnote_consent_sync", "necessary", "sessionStorage", "consentSync", { unit: "session" }),
  firstParty("cnote_web_at", "necessary", "cookie", "auth", { unit: "minutes", n: 15 }, true),
  firstParty("cnote_web_rt", "necessary", "cookie", "session", { unit: "days", n: 30 }, true),
  firstParty("cnote_web_oauth", "necessary", "cookie", "oauth", { unit: "minutes", n: 10 }, true),
  firstParty("cnote_web_mfa", "necessary", "cookie", "mfa", { unit: "minutes", n: 5 }, true),
  firstParty("cnote_locale", "necessary", "cookie", "locale", { unit: "years", n: 1 }),
  firstParty("cnote_rail", "necessary", "cookie", "rail", { unit: "years", n: 1 }),
  firstParty("cnote_pincode", "necessary", "cookie", "pincode", { unit: "years", n: 1 }),
  firstParty("cnote_compare", "necessary", "cookie", "compare", { unit: "days", n: 7 }),
  firstParty("cnote_lang_suggestion_dismissed", "necessary", "localStorage", "langSuggestion", { unit: "persistent" }),
  firstParty("cnote_voice_consent_v1", "necessary", "localStorage", "voiceConsent", { unit: "persistent" }),
  // --- analytics: Microsoft Clarity (only when NEXT_PUBLIC_CLARITY_PROJECT_ID is set AND analytics is granted) ----------
  clarity("_clck", "clarityId", { unit: "years", n: 1 }),
  clarity("_clsk", "claritySession", { unit: "days", n: 1 }),
  clarity("CLID", "clarityId", { unit: "years", n: 1 }),
  clarity("ANONCHK", "clarityMs", { unit: "minutes", n: 10 }),
  clarity("MR", "clarityMs", { unit: "days", n: 7 }),
  clarity("MUID", "clarityMs", { unit: "years", n: 1 }),
  clarity("SM", "clarityMs", { unit: "session" }),
  // --- marketing and attribution ------------------------------------------------------------------------------------
  // Written by the client (features/leadgen/visitor.ts) and, on ad clicks / similar-products, by the server as httpOnly.
  { ...firstParty("cnote_vid", "marketing", "cookie", "visitor", { unit: "days", n: 30 }), alsoServerSet: true },
  firstParty("cnote_ad_click", "marketing", "cookie", "adClick", { unit: "days", n: 7 }, true),
  firstParty("cnote_attr", "marketing", "sessionStorage", "attribution", { unit: "session" }),
  firstParty("cnote_lg_v1", "marketing", "localStorage", "nudgeHistory", { unit: "persistent" }),
  firstParty("cnote_lg_views", "marketing", "sessionStorage", "nudgeViews", { unit: "session" }),
  firstParty("cnote_lg_session", "marketing", "sessionStorage", "nudgeSession", { unit: "session" }),
  // Recently viewed rail (features/recently-viewed/store.ts): the ids of the last products opened on this device. Written only
  // with marketing granted; otherwise kept in memory for the page load. Nothing is sent to the server.
  firstParty("cnote_recent_v1", "marketing", "localStorage", "recentlyViewed", { unit: "persistent" }),
];

export const CATEGORIES: readonly StorageCategory[] = ["necessary", "analytics", "marketing"];

export const entriesOf = (category: StorageCategory): StorageEntry[] => STORAGE_REGISTRY.filter((e) => e.category === category);

/** Everything client code may (and, on withdrawal, must) delete for a category. httpOnly cookies are the server's job. */
export const clientClearable = (category: OptionalCategory): StorageEntry[] => entriesOf(category).filter((e) => !e.httpOnly);
/** Cookies the server expires when the category is not granted (POST /api/consent): httpOnly ones and server-written twins. */
export const serverClearable = (category: OptionalCategory): StorageEntry[] => entriesOf(category).filter((e) => e.httpOnly || e.alsoServerSet);

