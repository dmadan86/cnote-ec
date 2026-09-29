"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

// Root-layout failures render outside the app shell, so this page must bring its own <html>.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "3rem 1.5rem", textAlign: "center", color: "#111827" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700 }}>Something went wrong</h1>
        <p style={{ color: "#6b7280", marginTop: "0.5rem" }}>We&apos;ve been notified and are looking into it.</p>
        {error.digest ? <p style={{ color: "#6b7280", fontSize: "0.75rem" }}>Reference: {error.digest}</p> : null}
        <button
          onClick={reset}
          style={{ marginTop: "1.5rem", padding: "0.6rem 1.4rem", borderRadius: 999, border: 0, background: "#6d3ff0", color: "#fff", fontWeight: 600, cursor: "pointer" }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
