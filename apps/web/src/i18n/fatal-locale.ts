"use client";
import { useSyncExternalStore } from "react";
import { DEFAULT_LOCALE, LOCALE_COOKIE, localizePath, splitLocale, toLocale, isLocale, type Locale } from "./config";
import { FATAL_COPY, type FatalCopy } from "./fatal-copy";

/**
 * Language of a failure page that cannot rely on next-intl or the server request (global-error has no layout; the root
 * error/not-found also render when a locale layout above them failed, and the static not-found is prerendered once for every URL).
 * Order: the /<locale>/ prefix of the URL, else the `cnote_locale` cookie (unprefixed dynamic routes), else English.
 * Pure so it is unit-testable; the hook below applies it after hydration to avoid a server/client text mismatch.
 */
export function detectFatalLocale(pathname: string | null | undefined, cookieHeader: string | null | undefined): Locale {
  const split = splitLocale(pathname || "/");
  if (split.prefixed) return split.locale;
  const m = cookieHeader ? new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`).exec(cookieHeader) : null;
  const c = m ? toLocale(decodeURIComponent(m[1]!)) : null;
  return c && isLocale(c) ? c : DEFAULT_LOCALE;
}

export interface FatalView {
  locale: Locale;
  copy: FatalCopy;
  home: string;
  search: string;
}

const noop = () => () => undefined;

/** Copy + locale-aware links for a failure page. Server/hydration render English (matches the static HTML); the client then switches. */
export function useFatalView(): FatalView {
  const locale = useSyncExternalStore<Locale>(noop, () => detectFatalLocale(window.location.pathname, document.cookie), () => DEFAULT_LOCALE);
  return { locale, copy: FATAL_COPY[locale], home: localizePath("/", locale), search: localizePath("/search", locale) };
}
