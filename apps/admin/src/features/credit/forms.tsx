"use client";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { refreshBookAction, rescoreAction } from "@/app/(console)/credit/actions";

const input = "mt-1 block h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm";

export function RescoreForm() {
  return (
    <ActionForm action={rescoreAction} successMessage="Score recomputed.">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-72 text-xs">Business id
          <input name="businessId" required pattern="[0-9a-fA-F-]{36}" className={input} />
        </label>
        <label className="min-w-64 flex-1 text-xs">Reason
          <input name="reason" required minLength={3} maxLength={300} className={input} />
        </label>
        <SubmitButton size="sm">Recompute score</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function RefreshBookForm() {
  return (
    <ActionForm action={refreshBookAction} successMessage="Loan book refreshed.">
      <SubmitButton size="sm">Refresh DPD and expire offers</SubmitButton>
    </ActionForm>
  );
}
