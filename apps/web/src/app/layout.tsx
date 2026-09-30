import type { Metadata, Viewport } from "next";
import { getTranslations } from "next-intl/server";
import { Geist, Noto_Sans_Devanagari } from "next/font/google";
import { Analytics } from "@/features/analytics";
import { SiteFooter } from "@/features/shell/site-footer";
import { SiteHeader } from "@/features/shell/site-header";
import { SkipLink } from "@/features/shell/skip-link";
import { SITE_NAME, SITE_TAGLINE } from "@/features/shell/site";
import { HtmlShell } from "@/i18n/html-shell";
import { loadMessages, pickClientMessages } from "@/i18n/messages";
import { SITE_ORIGIN } from "@/lib/site-url";
import "./globals.css";

// Self-hosted at build time by next/font (no render-blocking third-party CSS), swapped in with a size-adjusted
// fallback so text is visible immediately and layout does not shift; preloaded for the latin subset only.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
  fallback: ["system-ui", "Arial"],
});

// Hindi (and later Marathi): Devanagari subset only. preload:false + unicode-range means the font file is fetched only
// when a page actually renders Devanagari text, so English pages pay nothing. Fallbacks are metric-close system fonts
// (Nirmala UI on Windows, Kohinoor/Devanagari Sangam on Apple, Noto on Android) to limit the swap shift.
const notoDevanagari = Noto_Sans_Devanagari({
  variable: "--font-devanagari",
  subsets: ["devanagari"],
  display: "swap",
  preload: false,
  fallback: ["Nirmala UI", "Kohinoor Devanagari", "Devanagari Sangam MN", "Mangal", "system-ui"],
});

const DESCRIPTION = "Find verified manufacturers and suppliers across India, compare real prices and get quotes, ranked by trust, never by payment.";

// Defaults for every route; localised routes override title/description/OG locale in app/[locale]/layout.tsx.
export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: { default: `${SITE_NAME} · ${SITE_TAGLINE}`, template: `%s · ${SITE_NAME}` },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: { type: "website", siteName: SITE_NAME, locale: "en_IN", title: `${SITE_NAME} · ${SITE_TAGLINE}`, description: DESCRIPTION },
  twitter: { card: "summary_large_image" },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 } },
};

export const viewport: Viewport = {
  themeColor: "#6d3ff0",
  width: "device-width",
  initialScale: 1,
};

// The root layout reads no cookies/headers, so every public page below it can be statically generated / ISR cached.
// <html lang> and the localised chrome are decided by HtmlShell from the route segment (see src/i18n/html-shell.tsx).
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const messages = pickClientMessages(await loadMessages("en"));
  return (
    <HtmlShell
      className={`${geistSans.variable} ${notoDevanagari.variable} h-full antialiased`}
      messages={messages}
      skip={<SkipLink label={(await getTranslations({ locale: "en", namespace: "shell" }))("skipToContent")} />}
      header={<SiteHeader locale="en" />}
      footer={<SiteFooter locale="en" />}
      extras={<Analytics />}
    >
      {children}
    </HtmlShell>
  );
}
