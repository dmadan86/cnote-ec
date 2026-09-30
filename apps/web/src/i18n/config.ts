// i18n configuration shared by server, client and the proxy (no server-only imports, no I/O).
// ADR-004: Hindi, Kannada, Tamil, Telugu, Marathi, Gujarati, Bengali + English. Only ACTIVE locales are routable;
// planned ones have a catalogue file (messages/<code>.json) that falls back to English until translated. To turn one
// on: translate its catalogue, then move it from PLANNED_LOCALES to LOCALES (see docs/guides/i18n.md).

export const LOCALES = ["en", "hi"] as const;
export type Locale = (typeof LOCALES)[number];

export const PLANNED_LOCALES = ["kn", "ta", "te", "mr", "gu", "bn"] as const;
export type PlannedLocale = (typeof PLANNED_LOCALES)[number];
export type CatalogueLocale = Locale | PlannedLocale;

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
}

export const LOCALE_META: Record<Locale, LocaleMeta> = {
  en: { bcp47: "en-IN", hreflang: "en-IN", ogLocale: "en_IN", native: "English" },
  hi: { bcp47: "hi-IN", hreflang: "hi-IN", ogLocale: "hi_IN", native: "हिन्दी" },
};

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
export const LOCALIZED_PREFIXES = ["/search", "/categories", "/c/", "/s/", "/p/", "/products/", "/manufacturers", "/pricing", "/coming-soon/"] as const;

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
