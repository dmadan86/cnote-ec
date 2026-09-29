import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Admin" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
