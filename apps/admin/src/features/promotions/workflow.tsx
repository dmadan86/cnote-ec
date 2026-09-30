"use client";
import { Input } from "@cnote/ui";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { approvePromotionAction, archivePromotionAction, returnPromotionAction, submitPromotionAction } from "./actions";

export function PromotionWorkflow({ id, status, canManage, canPublish, isAuthor }: { id: string; status: string; canManage: boolean; canPublish: boolean; isAuthor: boolean }) {
  return (
    <div className="flex flex-wrap items-start gap-3">
      {status === "draft" && canManage && isAuthor ? (
        <ActionForm action={submitPromotionAction} successMessage="Submitted for review."><input type="hidden" name="id" value={id} /><SubmitButton>Submit for review</SubmitButton></ActionForm>
      ) : null}
      {status === "in_review" && canPublish ? (
        isAuthor ? (
          <p className="max-w-sm text-sm text-muted">You wrote this promotion, so a different staff member must approve it (two-person rule).</p>
        ) : (
          <>
            <ActionForm action={approvePromotionAction} confirm="Approve and publish? It goes live inside its schedule window." successMessage="Approved."><input type="hidden" name="id" value={id} /><SubmitButton>Approve and publish</SubmitButton></ActionForm>
            <ActionForm action={returnPromotionAction} successMessage="Returned to the author."><input type="hidden" name="id" value={id} /><SubmitButton variant="outline">Return to draft</SubmitButton></ActionForm>
          </>
        )
      ) : null}
      {status !== "archived" && canPublish ? (
        <ActionForm action={archivePromotionAction} confirm="Pull this promotion now?" successMessage="Archived. It is off the site.">
          <input type="hidden" name="id" value={id} />
          <div className="flex items-end gap-2">
            <div><label htmlFor="arch-reason" className="block text-xs text-muted">Reason (required)</label><Input id="arch-reason" name="reason" required maxLength={300} className="w-56" /></div>
            <SubmitButton variant="danger">Archive now</SubmitButton>
          </div>
        </ActionForm>
      ) : null}
    </div>
  );
}
