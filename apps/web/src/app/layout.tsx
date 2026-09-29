import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { Analytics } from "@/features/analytics";
import { SiteFooter } from "@/features/shell/site-footer";
import { SiteHeader } from "@/features/shell/site-header";
import { SkipLink } from "@/features/shell/skip-link";
import { SITE_NAME, SITE_TAGLINE } from "@/features/shell/site";
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

const DESCRIPTION = "Find verified manufacturers and suppliers across India, compare real prices and get quotes, ranked by trust, never by payment.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: { default: `${SITE_NAME} · ${SITE_TAGLINE}`, template: `%s · ${SITE_NAME}` },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  // Pages set their own canonical; the locale map is the hreflang-ready structure (add hi-IN etc. here when translated).
  alternates: { languages: { "en-IN": "/" } },
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
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-IN" className={`${geistSans.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <SkipLink />
        <SiteHeader />
        <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
          {children}
        </main>
        <SiteFooter />
        <Analytics />
      </body>
    </html>
  );
}
