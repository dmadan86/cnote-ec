import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = { title: { default: "Storefront Studio", template: "%s · Storefront Studio" }, robots: { index: false, follow: false } };
export const viewport: Viewport = { themeColor: "#6d3ff0", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
