import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { APP_NAME } from "@/lib/brand";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: `${APP_NAME}: exclusive, intent-scored leads`, template: `%s | ${APP_NAME}` },
  description: "Get a few real buyer leads instead of a broadcast. Every lead shows its intent score, rank and cap. Free to start.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#6d3ff0" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
