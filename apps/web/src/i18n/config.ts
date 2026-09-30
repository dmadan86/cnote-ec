// i18n configuration shared by server, client and the proxy (no server-only imports, no I/O).
// ADR-004: English + Hindi, Kannada, Tamil, Telugu, Marathi, Gujarati, Bengali. All are routable; each has a catalogue
// (messages/<code>.json + <code>.<namespace>.json) that falls back per key to English (see docs/guides/i18n.md).

export const LOCALES = ["en", "hi", "kn", "ta", "te", "mr", "gu", "bn"] as const;
export type Locale = (typeof LOCALES)[number];
/** Every locale has a catalogue and is routable; kept as an alias for code that distinguished planned locales. */
export type CatalogueLocale = Locale;

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

export const isLocale = (v: unknown): v is Locale => typeof v === "string" && (LOCALES as readonly string[]).includes(v);

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
export const LOCALIZED_PREFIXES = ["/search", "/categories", "/c/", "/s/", "/p/", "/products/", "/manufacturers", "/pricing", "/ranking-and-ads", "/dispute-policy", "/coming-soon/"] as const;

export function isLocalizedPath(rest: string): boolean {
  return rest === "/" || LOCALIZED_PREFIXES.some((p) => (p.endsWith("/") ? rest.startsWith(p) : rest === p || rest.startsWith(`${p}/`)));
}

/** Adds the locale prefix for non-default locales. Absolute/external hrefs and non-localised paths are returned untouched. */
export function localizePath(path: string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE || !path.startsWith("/") || path.startsWith("//")) return path;
  const [pathOnly = "/"] = path.split(/[?#]/, 1);
  if (!isLocalizedPath(pathOnly)) return path;
  return path === "/" ? `/${locale}` : path.startsWith("/?") || path.startsWith("/#") ? `/${locale}${path.slice(1)}` : `/${locale}${path}`;
}
