"use client";
import { buttonClasses } from "@cnote/ui";

/** Reloads the page the visitor was trying to reach (the service worker serves /offline only while the network is down). */
export function RetryButton({ label }: { label: string }) {
  return (
    <button type="button" onClick={() => window.location.reload()} className={buttonClasses("primary", "lg")}>
      {label}
    </button>
  );
}
