import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { APP_NAME } from "@/lib/brand";
import { bcp47, isLocale, DEFAULT_LOCALE } from "@/i18n/config";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: `${APP_NAME}: exclusive, intent-scored leads`, template: `%s | ${APP_NAME}` },
  description: "Get a few real buyer leads instead of a broadcast. Every lead shows its intent score, rank and cap. Free to start.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#6d3ff0" };

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const raw = await getLocale();
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  return (
    <html lang={bcp47(locale)} className={`${geistSans.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <NextIntlClientProvider locale={locale} messages={await getMessages()} timeZone="Asia/Kolkata">
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
