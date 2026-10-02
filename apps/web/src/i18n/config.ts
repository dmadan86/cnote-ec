// i18n configuration shared by server, client and the proxy (no server-only imports, no I/O).
// ADR-004: English + Hindi, Kannada, Tamil, Telugu, Marathi, Gujarati, Bengali. Each has a catalogue
// (messages/<code>.json + <code>.<namespace>.json) that falls back per key to English (see docs/guides/i18n.md).

/** Every locale that has a catalogue on disk and LOCALE_META. `Locale` is typed over this list. */
export const ALL_LOCALES = ["en", "hi", "kn", "ta", "te", "mr", "gu", "bn"] as const;
export type Locale = (typeof ALL_LOCALES)[number];
/** Alias kept for code that distinguished catalogue locales from routable ones. */
export type CatalogueLocale = Locale;

/**
 * Locales LIVE on the buyer web (routable, in the switcher, hreflang/sitemap, suggestion banner, profile picker).
 * Per ADR-004 only English + Hindi ship now; kn/ta/te/mr/gu/bn keep their catalogues on disk and await native-speaker
 * review. To re-enable one, add its code here (order = switcher order). Nothing else changes. Disabled prefixes
 * (/kn/...) redirect to the English equivalent in the proxy, and every resolver falls back to English.
 */
export const LOCALES = ["en", "hi"] as const satisfies readonly Locale[];

/** `/` is English (en-IN) and stays unprefixed; every other locale is served under `/<code>/...`. */
export const DEFAULT_LOCALE: Locale = "en";

export interface LocaleMeta {
  /** BCP 47 tag for <html lang>, Intl and JSON-LD `inLanguage`. */
  bcp47: string;
  /** hreflang value (language-REGION). */
  hreflang: string;
  /** Open Graph locale. */
  ogLocale: string;
  /** Name of the language in its own script (shown in the switcher, with lang= on the option). */
  native: string;
  /** Script of the language; drives which Noto Sans subset renders it (Marathi shares Devanagari). */
  script: "latin" | "devanagari" | "kannada" | "tamil" | "telugu" | "gujarati" | "bengali";
  /** Locale for Intl date formatting: language + region IN with Latin digits (bn/mr default to native digits in CLDR). */
  intl: string;
}

const L = (code: string, ogLocale: string, native: string, script: LocaleMeta["script"]): LocaleMeta => ({
  bcp47: `${code}-IN`,
  hreflang: `${code}-IN`,
  ogLocale,
  native,
  script,
  intl: `${code}-IN-u-nu-latn`,
});

export const LOCALE_META: Record<Locale, LocaleMeta> = {
  en: L("en", "en_IN", "English", "latin"),
  hi: L("hi", "hi_IN", "हिन्दी", "devanagari"),
  kn: L("kn", "kn_IN", "ಕನ್ನಡ", "kannada"),
  ta: L("ta", "ta_IN", "தமிழ்", "tamil"),
  te: L("te", "te_IN", "తెలుగు", "telugu"),
  mr: L("mr", "mr_IN", "मराठी", "devanagari"),
  gu: L("gu", "gu_IN", "ગુજરાતી", "gujarati"),
  bn: L("bn", "bn_IN", "বাংলা", "bengali"),
};

/**
 * Indian-grouped number with Latin digits (12,34,567) for every locale. CLDR uses western grouping for kn/mr currency
 * and native digits for bn/mr, so numbers deliberately format with en-IN; dates use the locale (month names).
 */
export const formatNumber = (n: number, _locale: Locale, opts?: Intl.NumberFormatOptions) => new Intl.NumberFormat("en-IN", opts).format(n);

/** Date in the locale's language, fixed to IST so server and client agree. */
export const formatDate = (d: Date | string | number, locale: Locale, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium" }) =>
  new Intl.DateTimeFormat(LOCALE_META[locale].intl, { timeZone: "Asia/Kolkata", ...opts }).format(new Date(d));

/** Locale of a supported language tag ("hi", "hi-IN", "HI_in"), else null. */
export function toLocale(v: unknown): Locale | null {
  if (typeof v !== "string") return null;
  const code = v.trim().toLowerCase().split(/[-_]/, 1)[0];
  return isLocale(code) ? code : null;
}

/** Cookie holding the buyer's language for routes without a locale prefix (account, buyer, rfq, auth, ...). */
export const LOCALE_COOKIE = "cnote_locale";
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Best supported language of an Accept-Language header (q-weighted, first wins on ties), or null. */
export function matchAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part, i) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => /^\s*q\s*=\s*([\d.]+)\s*$/.exec(p)?.[1]).find(Boolean);
      return { locale: tag === "*" ? null : toLocale(tag), q: q === undefined ? 1 : Number(q), i };
    })
    .filter((x): x is { locale: Locale; q: number; i: number } => x.locale !== null && Number.isFinite(x.q) && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  return ranked[0]?.locale ?? null;
}

/**
 * Locale for routes that are not under /<locale>/ (they are dynamic, so it may depend on the request):
 * (a) the `cnote_locale` cookie, (b) the signed-in person's preferredLanguage, (c) Accept-Language, else English.
 * Pure: callers supply the inputs lazily so the session (b) is only loaded when the cookie is absent.
 */
export async function resolvePreferredLocale(src: {
  cookie: () => string | null | undefined | Promise<string | null | undefined>;
  preferred: () => string | null | undefined | Promise<string | null | undefined>;
  acceptLanguage: () => string | null | undefined | Promise<string | null | undefined>;
}): Promise<Locale> {
  const c = toLocale(await src.cookie());
  if (c) return c;
  const p = toLocale(await src.preferred());
  if (p) return p;
  return matchAcceptLanguage(await src.acceptLanguage()) ?? DEFAULT_LOCALE;
}

/** True only for ENABLED locales (see LOCALES); a disabled locale is never routable or resolvable. */
export const isLocale = (v: unknown): v is Locale => typeof v === "string" && (LOCALES as readonly string[]).includes(v);

/** True for any locale with a catalogue on disk, enabled or not. */
export const isCatalogueLocale = (v: unknown): v is Locale => typeof v === "string" && (ALL_LOCALES as readonly string[]).includes(v);

/** "/kn/search" -> "/search" when the prefix is a known-but-disabled locale (old links redirect to English), else null. */
export function disabledLocaleRest(pathname: string): string | null {
  const m = /^\/([a-z]{2})(\/.*)?$/.exec(pathname);
  return m && isCatalogueLocale(m[1]) && !isLocale(m[1]) ? (m[2] ?? "/") : null;
}

/** Splits "/hi/search" into { locale: "hi", rest: "/search" }; unprefixed paths are the default locale. */
export function splitLocale(pathname: string): { locale: Locale; prefixed: boolean; rest: string } {
  const m = /^\/([a-z]{2})(\/.*)?$/.exec(pathname);
  if (m && isLocale(m[1])) return { locale: m[1], prefixed: true, rest: m[2] ?? "/" };
  return { locale: DEFAULT_LOCALE, prefixed: false, rest: pathname || "/" };
}

/**
 * Public path prefixes that exist per locale (the [locale] route tree). Everything else (account, buyer, rfq, auth,
 * storefronts, APIs) is not localised yet and stays unprefixed and English.
 */
export const LOCALIZED_PREFIXES = ["/search", "/categories", "/c/", "/s/", "/p/", "/products/", "/manufacturers", "/pricing", "/ranking-and-ads", "/dispute-policy", "/cookies", "/terms", "/privacy", "/refund-policy", "/prohibited-items", "/report", "/about", "/contact", "/trust", "/accessibility", "/security", "/sitemap", "/coming-soon/"] as const;

export function isLocalizedPath(rest: string): boolean {
  return rest === "/" || LOCALIZED_PREFIXES.some((p) => (p.endsWith("/") ? rest.startsWith(p) : rest === p || rest.startsWith(`${p}/`)));
}

/**
 * Dynamic routes without a locale prefix whose language comes from the `cnote_locale` cookie / preferredLanguage
 * (they render in the (app) route group). Storefronts (/store/...) and other unprefixed pages stay English.
 */
export const COOKIE_LOCALE_PREFIXES = ["/account", "/buyer", "/rfq", "/wishlist", "/compare", "/onboarding", "/grievance", "/conversations", "/signin", "/signup", "/forgot-password", "/reset-password"] as const;

export function isCookieLocalePath(rest: string): boolean {
  return COOKIE_LOCALE_PREFIXES.some((p) => rest === p || rest.startsWith(`${p}/`));
}

/** Adds the locale prefix for non-default locales. Absolute/external hrefs and non-localised paths are returned untouched. */
export function localizePath(path: string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE || !path.startsWith("/") || path.startsWith("//")) return path;
  const [pathOnly = "/"] = path.split(/[?#]/, 1);
  if (!isLocalizedPath(pathOnly)) return path;
  return path === "/" ? `/${locale}` : path.startsWith("/?") || path.startsWith("/#") ? `/${locale}${path.slice(1)}` : `/${locale}${path}`;
}
