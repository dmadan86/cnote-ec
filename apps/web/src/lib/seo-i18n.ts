import { DEFAULT_LOCALE, LOCALE_META, LOCALES, localizePath, type Locale } from "@/i18n/config";

/**
 * Canonical + hreflang alternates for a localised public page. `path` is the unprefixed path (e.g. "/c/packaging").
 * Each locale's canonical points at itself (never at English); every locale lists all alternates plus x-default
 * (English, the unprefixed URL). URLs are relative and resolved against metadataBase.
 */
export function localizedAlternates(path: string, locale: Locale): { canonical: string; languages: Record<string, string> } {
  return {
    canonical: localizePath(path, locale),
    languages: {
      ...Object.fromEntries(LOCALES.map((l) => [LOCALE_META[l].hreflang, localizePath(path, l)])),
      "x-default": localizePath(path, DEFAULT_LOCALE),
    },
  };
}

/** Alternates for query-dependent pages that should only self-canonicalise (no hreflang cluster, e.g. noindex search). */
export function selfAlternates(path: string, locale: Locale): { canonical: string } {
  return { canonical: localizePath(path, locale) };
}

/** `sitemap.xml` alternates map (`xhtml:link`) for a path: { "en-IN": abs, "hi-IN": abs, "x-default": abs }. */
export function sitemapLanguages(path: string, abs: (p: string) => string): Record<string, string> {
  return {
    ...Object.fromEntries(LOCALES.map((l) => [LOCALE_META[l].hreflang, abs(localizePath(path, l))])),
    "x-default": abs(localizePath(path, DEFAULT_LOCALE)),
  };
}

export const ogLocale = (locale: Locale) => LOCALE_META[locale].ogLocale;
export const inLanguage = (locale: Locale) => LOCALE_META[locale].bcp47;
