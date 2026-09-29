"use client";
import { Textarea } from "@cnote/ui";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { reviewVersionAction } from "./actions";

/** Approve / Reject. The note is required to reject (enforced again server-side) and is shown to the seller. */
export function VersionReviewForm({ versionId }: { versionId: string }) {
  return (
    <ActionForm action={reviewVersionAction} successMessage="Decision recorded. Approved versions go live within a minute." className="space-y-2">
      <input type="hidden" name="versionId" value={versionId} />
      <label htmlFor="note" className="sr-only">Note for the seller (required to reject)</label>
      <Textarea id="note" name="note" maxLength={1000} placeholder="Note for the seller (required to reject)" className="min-h-20" />
      <div className="flex gap-2">
        <SubmitButton name="decision" value="approved">Approve</SubmitButton>
        <SubmitButton name="decision" value="rejected" variant="danger">Reject</SubmitButton>
      </div>
    </ActionForm>
  );
}
