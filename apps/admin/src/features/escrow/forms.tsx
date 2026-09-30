"use client";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { refundEscrowAction, releaseEscrowAction, resolveIssueAction, runReconciliationAction } from "@/app/(console)/escrow/actions";

const input = "mt-1 block h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm";

export function MoveForm({ escrowId, kind }: { escrowId: string; kind: "release" | "refund" }) {
  const release = kind === "release";
  return (
    <ActionForm
      action={release ? releaseEscrowAction : refundEscrowAction}
      confirm={release ? "Release everything held to the seller? This moves real money and cannot be undone." : "Refund everything held to the buyer? This moves real money and cannot be undone."}
      successMessage={release ? "Release queued." : "Refund queued."}
    >
      <input type="hidden" name="escrowId" value={escrowId} />
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-64 flex-1 text-xs">Reason
          <input name="reason" required minLength={3} maxLength={300} className={input} />
        </label>
        <SubmitButton variant={release ? "primary" : "danger"} size="sm">{release ? "Release to seller" : "Refund to buyer"}</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function ResolveIssueForm({ issueId }: { issueId: string }) {
  return (
    <ActionForm action={resolveIssueAction} successMessage="Issue resolved.">
      <input type="hidden" name="issueId" value={issueId} />
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-56 flex-1 text-xs">Resolution note
          <input name="note" required minLength={3} maxLength={500} className={input} />
        </label>
        <SubmitButton size="sm">Resolve</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function RunReconciliationForm() {
  return (
    <ActionForm action={runReconciliationAction} successMessage="Reconciliation finished.">
      <SubmitButton size="sm">Run reconciliation now</SubmitButton>
    </ActionForm>
  );
}
