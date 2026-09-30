import { NextIntlClientProvider } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { getTranslations } from "next-intl/server";
import { Analytics } from "@/features/analytics";
import { SiteFrame } from "@/features/rail/site-frame";
import { SiteFooter } from "@/features/shell/site-footer";
import { SiteHeader } from "@/features/shell/site-header";
import { SkipLink } from "@/features/shell/skip-link";
import { setAppLocale } from "@/i18n/app-locale";
import { HtmlLang, IST } from "@/i18n/html-shell";
import { APP_CLIENT_NAMESPACES, loadMessages, pickClientMessages } from "@/i18n/messages";
import { getRequestLocale } from "@/lib/request-locale";

/**
 * Chrome for the dynamic routes (account, buyer, rfq, wishlist, compare, auth, ...). Their language is not in the URL:
 * cnote_locale cookie, else the person's preferredLanguage, else Accept-Language (see lib/request-locale.ts). Reading
 * the request here makes this whole group dynamic, which is what these session-bound pages already are.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const locale = await getRequestLocale();
  setRequestLocale(locale);
  setAppLocale(locale); // ambient next-intl calls (useTranslations in server components, getLocale in actions) follow the request
  const messages = pickClientMessages(await loadMessages(locale), APP_CLIENT_NAMESPACES);
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone={IST}>
      <HtmlLang locale={locale} />
      <SkipLink label={(await getTranslations({ locale, namespace: "shell" }))("skipToContent")} />
      <SiteHeader locale={locale} />
      <SiteFrame footer={<SiteFooter locale={locale} />}>{children}</SiteFrame>
      <Analytics />
    </NextIntlClientProvider>
  );
}
