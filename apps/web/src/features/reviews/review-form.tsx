"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Field, Input, Textarea } from "@cnote/ui";
import { SubmitButton } from "./submit-button";
import { useActionState } from "react";
import { submitReviewAction } from "./actions";
import { StarInput } from "./star-input";

const fe = (s: ActionResult | null, k: string) => (s && !s.ok ? s.fieldErrors?.[k] : undefined);

export function ReviewForm({ listingId, initial }: { listingId: string; initial?: { rating: number; title: string | null; body: string } }) {
  const [state, action] = useActionState<ActionResult | null, FormData>(submitReviewAction, null);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="listingId" value={listingId} />
      <StarInput defaultValue={initial?.rating ?? 0} error={fe(state, "rating")} />
      <Field label="Title (optional)" htmlFor="rv-title" error={fe(state, "title")}>
        <Input id="rv-title" name="title" maxLength={120} defaultValue={initial?.title ?? ""} placeholder="Sum it up in a few words" />
      </Field>
      <Field label="Your review" htmlFor="rv-body" hint="At least 10 characters. Don't include phone numbers or emails." error={fe(state, "body")}>
        <Textarea id="rv-body" name="body" required minLength={10} maxLength={2000} rows={5} defaultValue={initial?.body ?? ""} placeholder="Quality, packing, delivery, how the seller dealt with you" />
      </Field>
      {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
      {state?.ok ? <Alert tone="success">Thanks! Your review is awaiting approval and will appear once our team has checked it.</Alert> : null}
      <SubmitButton pendingText="Submitting…">{initial ? "Update review" : "Submit review"}</SubmitButton>
    </form>
  );
}
