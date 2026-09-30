import { DEFAULT_LOCALE, bcp47, type Locale } from "@/i18n/config";

// Dates follow the seller's chosen language. Latin digits are forced (bn/mr default to native digits) and the
// zone is always IST. Formatters are cached per locale.
const dtCache = new Map<Locale, Intl.DateTimeFormat>();
const dCache = new Map<Locale, Intl.DateTimeFormat>();

function fmt(cache: Map<Locale, Intl.DateTimeFormat>, locale: Locale, withTime: boolean): Intl.DateTimeFormat {
  let f = cache.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(bcp47(locale), {
      dateStyle: "medium",
      ...(withTime ? { timeStyle: "short" as const } : {}),
      timeZone: "Asia/Kolkata",
      numberingSystem: "latn",
    });
    cache.set(locale, f);
  }
  return f;
}

export function formatDateTime(iso: string, locale: Locale = DEFAULT_LOCALE): string {
  return fmt(dtCache, locale, true).format(new Date(iso));
}
export function formatDate(iso: string, locale: Locale = DEFAULT_LOCALE): string {
  return fmt(dCache, locale, false).format(new Date(iso));
}
