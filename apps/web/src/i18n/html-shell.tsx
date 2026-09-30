"use client";
import { useSelectedLayoutSegment } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { useEffect, type ReactNode } from "react";
import { SiteFrame } from "@/features/rail/site-frame";
import { DEFAULT_LOCALE, isLocale, LOCALE_META, type Locale } from "./config";
import { rememberLocale } from "./locale-cookie";

/** Indian Standard Time: fixed so server and client format dates identically (and next-intl needs an explicit zone). */
export const IST = "Asia/Kolkata";

/** Route group of the dynamic (cookie-locale) routes: account, buyer, rfq, auth, ... Their layout renders its own translated chrome. */
export const APP_SEGMENT = "(app)";

/**
 * Sets <html lang> for the dynamic routes. The root layout is static (it cannot read the cookie), so the server-rendered
 * tag says en-IN; this corrects it right after hydration and restores it when the person navigates back to a public page.
 */
export function HtmlLang({ locale }: { locale: Locale }) {
  const tag = LOCALE_META[locale].bcp47;
  useEffect(() => {
    const el = document.documentElement;
    const before = el.lang;
    el.lang = tag;
    return () => {
      el.lang = before;
    };
  }, [tag]);
  return null;
}

/**
 * <html>/<body> for the whole app. Localised routes live under app/[locale]; a layout above [locale] cannot read the
 * param on the server, but useSelectedLayoutSegment() works during static rendering, so <html lang> is correct in the
 * prerendered HTML of every locale without making anything dynamic.
 *
 * Localised routes render their own translated chrome (app/[locale]/layout.tsx). Everything else (account, buyer, rfq,
 * auth, storefronts) is English and gets the English chrome passed in here as pre-rendered server elements.
 */
export function HtmlShell({
  className,
  head,
  messages,
  skip,
  header,
  footer,
  extras,
  children,
}: {
  className: string;
  /** Extra <head> content (the pre-paint rail script). */
  head?: ReactNode;
  messages: Record<string, unknown>;
  skip: ReactNode;
  header: ReactNode;
  footer: ReactNode;
  extras: ReactNode;
  children: ReactNode;
}) {
  const segment = useSelectedLayoutSegment();
  const localized = isLocale(segment);
  const lang = localized ? LOCALE_META[segment].bcp47 : "en-IN";
  // Visiting a localised public page remembers its language for the unprefixed routes (client-side: a Set-Cookie on
  // these cacheable pages would defeat the CDN). English is the unprefixed default, so it is only stored by the switcher.
  useEffect(() => {
    if (localized && segment !== DEFAULT_LOCALE) rememberLocale(segment);
  }, [localized, segment]);
  return (
    <html lang={lang} className={className} suppressHydrationWarning>
      {/* eslint-disable-next-line @next/next/no-head-element -- App Router root layout: this is the document <head> (pre-paint rail script) */}
      <head>{head}</head>
      <body className="flex min-h-full flex-col">
        {localized || segment === APP_SEGMENT ? (
          children
        ) : (
          <NextIntlClientProvider locale="en" messages={messages} timeZone={IST}>
            {skip}
            {header}
            <SiteFrame footer={footer}>{children}</SiteFrame>
            {extras}
          </NextIntlClientProvider>
        )}
      </body>
    </html>
  );
}
