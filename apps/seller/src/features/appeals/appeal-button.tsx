"use client";
import { Alert, Button, Field, Textarea } from "@cnote/ui";
import { useActionState, useId } from "react";
import { fileAppealAction, type AppealResult } from "./actions";

export type AppealSubjectType = "listing_version" | "listing_image" | "review" | "comment" | "storefront_version";

/**
 * "Appeal this decision" entry point. Mount it next to any REJECTED listing version, listing image, review/comment or
 * storefront version, passing the id of the rejected item. It is a disclosure (details/summary) so it needs no JS to open.
 */
export function AppealDecision({ subjectType, subjectId, label = "Appeal this decision" }: { subjectType: AppealSubjectType; subjectId: string; label?: string }) {
  const [state, action, pending] = useActionState<AppealResult | null, FormData>(fileAppealAction, null);
  const uid = useId();
  if (state?.ok) return <Alert tone="success">Appeal sent. Our team will review it and you will be notified of the outcome. <a className="underline" href="/appeals">View your appeals</a></Alert>;
  const reasonError = state && !state.ok ? state.fieldErrors?.reason : undefined;
  return (
    <details className="rounded-lg border border-line bg-surface p-3 text-sm">
      <summary className="cursor-pointer font-medium text-brand-700">{label}</summary>
      <form action={action} className="mt-3 flex flex-col gap-3" noValidate>
        <input type="hidden" name="subjectType" value={subjectType} />
        <input type="hidden" name="subjectId" value={subjectId} />
        {state && !state.ok && !state.fieldErrors ? <Alert tone="danger">{state.error}</Alert> : null}
        <Field label="Why should we reconsider?" htmlFor={`${uid}-reason`} hint="One appeal per decision. Be specific." error={reasonError}>
          <Textarea id={`${uid}-reason`} name="reason" rows={4} maxLength={2000} required />
        </Field>
        <div><Button type="submit" size="sm" disabled={pending}>{pending ? "Sending…" : "Send appeal"}</Button></div>
      </form>
    </details>
  );
}
