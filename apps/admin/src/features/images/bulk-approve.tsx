"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert } from "@cnote/ui";
import { useActionState } from "react";
import { SubmitButton } from "@/components/action-form";
import { bulkApproveImagesAction } from "./actions";

export const BULK_FORM_ID = "bulk-approve-images";

/** Checkboxes live in the cards (`form={BULK_FORM_ID}`) so each card can keep its own forms. */
export function BulkApproveBar() {
  const [state, action] = useActionState<ActionResult<{ approved: number; failed: number }> | null, FormData>(bulkApproveImagesAction, null);
  return (
    <form id={BULK_FORM_ID} action={action} className="flex flex-wrap items-center gap-3">
      <SubmitButton size="sm">Approve selected</SubmitButton>
      <span className="text-sm text-muted">Tick the images to approve, then confirm. Each decision is audited.</span>
      {state && !state.ok ? <Alert tone="danger" className="w-full">{state.error}</Alert> : null}
      {state?.ok ? <Alert tone={state.data.failed ? "warning" : "success"} className="w-full">Approved {state.data.approved}{state.data.failed ? `, ${state.data.failed} could not be approved (already decided?)` : ""}.</Alert> : null}
    </form>
  );
}
