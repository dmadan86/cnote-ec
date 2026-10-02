// Storage registry types and helpers. Each app owns ONE registry (a `StorageEntry[]`) listing every cookie / browser-storage
// key it writes, with category, provider, purpose and duration; the preferences dialog, the policy page, the withdrawal cleanup and
// the registry tests all read it. The helpers here take the registry as an argument so every app can reuse them.
//
// Categories (the user-facing consent purposes):
//   necessary  strictly necessary: sign-in/security, or something the user explicitly asked for (language, pincode,
//              rail toggle, compare tray, dismissing a banner). Exempt from consent (DPDP s.7; ePrivacy Art 5(3)).
//   analytics  measurement (Microsoft Clarity on the buyer web; first-party onboarding timing in the seller app).
//   marketing  visitor id, ad-click + campaign / referral attribution, lead-gen nudge history, third-party marketing embeds.
//   functional preferences & personalisation the visitor did not explicitly ask for, e.g. "recently viewed" (opt-in, default off;
//              Global Privacy Control does not affect it), and third-party embeds that only serve content (maps).
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

export const firstParty = (name: string, category: StorageCategory, kind: StorageKind, purpose: string, duration: Duration, httpOnly = false): StorageEntry => ({
  name, category, kind, provider: "firstParty", purpose, duration, ...(httpOnly ? { httpOnly } : {}),
});

/** The user-facing category order (necessary first). */
export const ALL_CATEGORIES: readonly StorageCategory[] = ["necessary", "analytics", "marketing", "functional"];

export const entriesOf = (registry: readonly StorageEntry[], category: StorageCategory): StorageEntry[] => registry.filter((e) => e.category === category);

/** Categories that have at least one entry (plus necessary), in the user-facing order: an app only offers switches it can honour. */
export const categoriesOf = (registry: readonly StorageEntry[]): StorageCategory[] =>
  ALL_CATEGORIES.filter((c) => c === "necessary" || registry.some((e) => e.category === c));

/** Everything client code may (and, on withdrawal, must) delete for a category. httpOnly cookies are the server's job. */
export const clientClearable = (registry: readonly StorageEntry[], category: OptionalCategory): StorageEntry[] => entriesOf(registry, category).filter((e) => !e.httpOnly);
/** Cookies the server expires when the category is not granted (POST /api/consent): httpOnly ones and server-written twins. */
export const serverClearable = (registry: readonly StorageEntry[], category: OptionalCategory): StorageEntry[] => entriesOf(registry, category).filter((e) => e.httpOnly || e.alsoServerSet);

/** Strips the `__Host-` / `__Secure-` prefix the auth cookies carry in production, so a name matches its registry entry. */
export const stripCookiePrefix = (name: string): string => name.replace(/^__(?:Host|Secure)-/, "");

/**
 * An app with only strictly necessary storage registers its keys and shows no banner. The per-app registry test asserts
 * `optionalEntries(registry)` is empty: the day an optional key is added, the test fails and points at the work (a banner, a
 * consent gate, a policy version).
 */
export function optionalEntries(registry: readonly StorageEntry[]): StorageEntry[] {
  return registry.filter((e) => e.category !== "necessary");
}
