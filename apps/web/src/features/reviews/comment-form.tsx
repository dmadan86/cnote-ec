"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Textarea } from "@cnote/ui";
import { useActionState, useEffect, useRef } from "react";
import { submitCommentAction } from "./actions";
import { SubmitButton } from "./submit-button";

export function CommentForm({ listingId }: { listingId: string }) {
  const [state, action] = useActionState<ActionResult | null, FormData>(submitCommentAction, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) ref.current?.reset();
  }, [state]);
  const err = state && !state.ok ? (state.fieldErrors?.body ?? state.error) : undefined;
  return (
    <form ref={ref} action={action} className="space-y-2">
      <input type="hidden" name="listingId" value={listingId} />
      <label htmlFor="q-body" className="text-sm font-medium text-ink">Ask the seller or the community</label>
      <Textarea id="q-body" name="body" required minLength={2} maxLength={1000} rows={3} aria-invalid={err ? true : undefined} aria-describedby={err ? "q-err" : undefined} placeholder="e.g. Is a GST invoice provided? What is the lead time for 500 pcs?" />
      {err ? <p id="q-err" role="alert" className="text-xs text-danger">{err}</p> : null}
      {state?.ok ? <Alert tone="success">Thanks! Your question is awaiting approval before it appears here.</Alert> : null}
      <SubmitButton pendingText="Posting…" variant="outline-brand">Post question</SubmitButton>
    </form>
  );
}
