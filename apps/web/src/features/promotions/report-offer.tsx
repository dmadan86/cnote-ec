"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Textarea } from "@cnote/ui";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { reportOfferAction } from "./actions";

export interface ReportLabels {
  summary: string;
  intro: string;
  noteLabel: string;
  submit: string;
  sending: string;
  thanks: string;
}

function Submit({ label, pending: pendingLabel }: { label: string; pending: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="outline" disabled={pending} aria-busy={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

/**
 * "Report offer not honoured". A client island so the static product page stays cacheable: the server action checks the
 * session, and a signed-out buyer gets the sign-in message inline (announced via role="alert").
 */
export function ReportOffer({ offerId, labels }: { offerId: string; labels: ReportLabels }) {
  const [state, action] = useActionState<ActionResult | null, FormData>(reportOfferAction, null);
  return (
    <details className="rounded-card border border-line bg-surface p-3 text-sm">
      <summary className="min-h-6 cursor-pointer font-medium text-ink focus-visible:outline-2 focus-visible:outline-brand-600">{labels.summary}</summary>
      <form action={action} className="mt-3 space-y-2">
        <input type="hidden" name="offerId" value={offerId} />
        <p className="text-muted">{labels.intro}</p>
        <label htmlFor={`report-note-${offerId}`} className="block font-medium text-ink">
          {labels.noteLabel}
        </label>
        <Textarea id={`report-note-${offerId}`} name="note" rows={3} maxLength={1000} aria-describedby={state && !state.ok ? `report-err-${offerId}` : undefined} />
        <div aria-live="polite">
          {state && !state.ok ? (
            <p id={`report-err-${offerId}`} role="alert" className="text-danger">
              {state.error}
            </p>
          ) : null}
          {state?.ok ? <Alert tone="success">{labels.thanks}</Alert> : null}
        </div>
        <Submit label={labels.submit} pending={labels.sending} />
      </form>
    </details>
  );
}
