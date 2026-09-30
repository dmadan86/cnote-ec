"use client";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { republishCellAction, runNowAction, setKAction, unpublishCellAction } from "./actions";

const input = "mt-1 block h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm";

export function KForm({ k }: { k: number }) {
  return (
    <ActionForm action={setKAction} successMessage="Threshold saved. It applies from the next run.">
      <div className="flex flex-wrap items-end gap-2">
        <label className="w-28 text-xs">k (3 to 100)
          <input name="k" type="number" required min={3} max={100} step={1} defaultValue={k} className={input} />
        </label>
        <label className="min-w-56 flex-1 text-xs">Reason
          <input name="reason" required minLength={3} maxLength={300} className={input} />
        </label>
        <SubmitButton size="sm">Save threshold</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function RunNowForm() {
  return (
    <ActionForm action={runNowAction} successMessage="Run finished.">
      <SubmitButton size="sm">Run aggregation now</SubmitButton>
    </ActionForm>
  );
}

export function UnpublishForm({ cellId }: { cellId: string }) {
  return (
    <ActionForm action={unpublishCellAction} confirm="Take this benchmark cell down now?" successMessage="Cell unpublished.">
      <input type="hidden" name="cellId" value={cellId} />
      <div className="flex items-end gap-2">
        <label className="text-xs"><span className="sr-only">Reason</span>
          <input name="reason" required minLength={3} maxLength={300} placeholder="Reason" className={input} />
        </label>
        <SubmitButton variant="danger" size="sm">Unpublish</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function RepublishForm({ cellId }: { cellId: string }) {
  return (
    <ActionForm action={republishCellAction} successMessage="Cell republished.">
      <input type="hidden" name="cellId" value={cellId} />
      <SubmitButton size="sm">Republish</SubmitButton>
    </ActionForm>
  );
}
