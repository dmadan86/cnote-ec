"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { LOCALE_META } from "@/i18n/config";
import { useFatalView } from "@/i18n/fatal-locale";

// Root-layout failures render outside the app shell, so this page must bring its own <html> and cannot use next-intl (no provider,
// no request). Language comes from the URL prefix / cnote_locale cookie after hydration (fatal-locale.ts); <html lang> follows it.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { locale, copy } = useFatalView();
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang={LOCALE_META[locale].bcp47} suppressHydrationWarning>
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "3rem 1.5rem", textAlign: "center", color: "#111827" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700 }}>{copy.errorTitle}</h1>
        <p style={{ color: "#6b7280", marginTop: "0.5rem" }}>{copy.errorText}</p>
        {error.digest ? (
          <p style={{ color: "#6b7280", fontSize: "0.75rem" }}>
            {copy.reference}: {error.digest}
          </p>
        ) : null}
        <button
          onClick={reset}
          style={{ marginTop: "1.5rem", padding: "0.6rem 1.4rem", borderRadius: 999, border: 0, background: "#6d3ff0", color: "#fff", fontWeight: 600, cursor: "pointer" }}
        >
          {copy.tryAgain}
        </button>
      </body>
    </html>
  );
}
