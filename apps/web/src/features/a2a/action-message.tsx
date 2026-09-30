"use client";
import { Alert } from "@cnote/ui";
import type { A2aActionResult } from "./actions";
import type { A2aLabels } from "./labels";

/** Catalogue key -> translated text; anything else (a server DomainError message) is shown as is. */
export const text = (t: A2aLabels, key: string): string => (key in t ? t[key as keyof A2aLabels] : key);

/** Always-mounted polite live region so assistive tech announces the outcome; errors use role="alert" (Alert danger). */
export function ActionMessage({ state, t, id }: { state: A2aActionResult | null; t: A2aLabels; id?: string }) {
  return (
    <div id={id} aria-live="polite" aria-atomic="true">
      {state ? state.ok ? <Alert tone="success">{text(t, state.data.done)}</Alert> : <Alert tone="danger">{text(t, state.error)}</Alert> : null}
    </div>
  );
}
