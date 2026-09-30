import { cache } from "react";
import { DEFAULT_LOCALE, type Locale } from "./config";

// Request-scoped holder for the language of the dynamic (app) routes. The (app) layout resolves it from the request
// (lib/request-locale.ts) and stores it here; next-intl calls made without an explicit locale (useTranslations in a
// server component) then read it through request.ts. It never touches cookies/headers itself, so the static public
// pages, which never set it, keep their static rendering (a stray call there gets English, as before).
const holder = cache((): { locale: Locale | null } => ({ locale: null }));

export function setAppLocale(locale: Locale): void {
  holder().locale = locale;
}

export function getAppLocale(): Locale {
  return holder().locale ?? DEFAULT_LOCALE;
}
