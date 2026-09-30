"use client";
import { useSelectedLayoutSegment } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { isLocale, LOCALE_META } from "./config";

/** Indian Standard Time: fixed so server and client format dates identically (and next-intl needs an explicit zone). */
export const IST = "Asia/Kolkata";

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
  messages,
  skip,
  header,
  footer,
  extras,
  children,
}: {
  className: string;
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
  return (
    <html lang={lang} className={className}>
      <body className="flex min-h-full flex-col">
        {localized ? (
          children
        ) : (
          <NextIntlClientProvider locale="en" messages={messages} timeZone={IST}>
            {skip}
            {header}
            <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
              {children}
            </main>
            {footer}
            {extras}
          </NextIntlClientProvider>
        )}
      </body>
    </html>
  );
}
