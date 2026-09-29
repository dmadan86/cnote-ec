"use client";
import { Textarea } from "@cnote/ui";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { moderateAction } from "./actions";

/** Approve / Reject with a note. The note is required to reject (enforced again server-side) and is shown to the author. */
export function DecisionForm({ kind, id }: { kind: "review" | "comment" | "reply"; id: string }) {
  return (
    <ActionForm action={moderateAction} successMessage="Decision recorded." className="space-y-2">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="id" value={id} />
      <label htmlFor={`note-${id}`} className="sr-only">Note to the author (required to reject)</label>
      <Textarea id={`note-${id}`} name="note" maxLength={500} placeholder="Note to the author (required to reject)" className="min-h-16" />
      <div className="flex gap-2">
        <SubmitButton name="decision" value="approved" size="sm">Approve</SubmitButton>
        <SubmitButton name="decision" value="rejected" variant="danger" size="sm">Reject</SubmitButton>
      </div>
    </ActionForm>
  );
}
