import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Analytics } from "@/features/analytics";
import { SiteFooter } from "@/features/shell/site-footer";
import { SiteHeader } from "@/features/shell/site-header";
import { SkipLink } from "@/features/shell/skip-link";
import { SITE_NAME } from "@/features/shell/site";
import { IST } from "@/i18n/html-shell";
import { isLocale, LOCALES, LOCALE_META } from "@/i18n/config";
import { loadMessages, pickClientMessages } from "@/i18n/messages";

// Every locale is prerendered; an unknown /<xx>/ prefix falls through to notFound().
export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata(props: LayoutProps<"/[locale]">): Promise<Metadata> {
  const { locale } = await props.params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "meta" });
  const title = `${SITE_NAME} · ${t("tagline")}`;
  return {
    title: { default: title, template: `%s · ${SITE_NAME}` },
    description: t("description"),
    openGraph: { type: "website", siteName: SITE_NAME, locale: LOCALE_META[locale].ogLocale, title, description: t("description") },
  };
}

// Chrome for localised routes. Root layout renders <html lang> (HtmlShell); this renders everything inside <body>.
export default async function LocaleLayout({ children, params }: LayoutProps<"/[locale]">) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  const messages = pickClientMessages(await loadMessages(locale));
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone={IST}>
      <SkipLink label={(await getTranslations({ locale, namespace: "shell" }))("skipToContent")} />
      <SiteHeader locale={locale} />
      <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
        {children}
      </main>
      <SiteFooter locale={locale} />
      <Analytics />
    </NextIntlClientProvider>
  );
}
