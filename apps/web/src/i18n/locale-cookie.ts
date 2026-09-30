"use client";
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, isLocale } from "./config";

/** Client-side write of the `cnote_locale` cookie (no-op when unchanged or without a document). Never set on the server for public pages. */
export function rememberLocale(locale: string): void {
  if (typeof document === "undefined" || !isLocale(locale)) return;
  try {
    if (document.cookie.split("; ").includes(`${LOCALE_COOKIE}=${locale}`)) return;
    document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
  } catch {
    /* cookies blocked: the URL still carries the language on public pages */
  }
}
