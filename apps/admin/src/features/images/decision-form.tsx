"use client";
import { Textarea } from "@cnote/ui";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { moderateImageAction } from "./actions";

/** Approve / Reject. The note is required to reject (enforced again server-side) and is shown to the seller. */
export function ImageDecisionForm({ id, compact = false }: { id: string; compact?: boolean }) {
  return (
    <ActionForm action={moderateImageAction} successMessage="Decision recorded." className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <label htmlFor={`note-${id}`} className="sr-only">Reason shown to the seller (required to reject)</label>
      <Textarea id={`note-${id}`} name="note" maxLength={500} placeholder="Reason shown to the seller (required to reject)" className={compact ? "min-h-14" : "min-h-20"} />
      <div className="flex gap-2">
        <SubmitButton name="decision" value="approved" size="sm">Approve</SubmitButton>
        <SubmitButton name="decision" value="rejected" variant="danger" size="sm">Reject</SubmitButton>
      </div>
    </ActionForm>
  );
}
