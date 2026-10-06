"use client";
import { Select, Textarea } from "@cnote/ui";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { completeNomineeAction, decideAppealAction, decideNomineeAction, respondGrievanceAction, retentionDryRunAction } from "./actions";

export function GrievanceResponseForm({ id }: { id: string }) {
  return (
    <ActionForm action={respondGrievanceAction} successMessage="Response recorded." className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <label htmlFor={`res-${id}`} className="text-xs font-medium text-muted">Resolution shown to the person (required to close)</label>
      <Textarea id={`res-${id}`} name="resolution" maxLength={5000} className="min-h-20" />
      <div className="flex flex-wrap gap-2">
        <SubmitButton name="status" value="in_progress" variant="outline" size="sm">Acknowledge</SubmitButton>
        <SubmitButton name="status" value="resolved" size="sm">Resolve</SubmitButton>
        <SubmitButton name="status" value="rejected" variant="danger" size="sm">Close without action</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function AppealDecisionForm({ id }: { id: string }) {
  return (
    <ActionForm action={decideAppealAction} successMessage="Decision recorded." confirm="Record this decision? An upheld appeal re-approves the content where it can be automated." className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <label htmlFor={`note-${id}`} className="text-xs font-medium text-muted">Note shown to the person (required)</label>
      <Textarea id={`note-${id}`} name="note" maxLength={500} required className="min-h-20" />
      <div className="flex gap-2">
        <SubmitButton name="decision" value="resolved" size="sm">Uphold appeal</SubmitButton>
        <SubmitButton name="decision" value="rejected" variant="danger" size="sm">Decision stands</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function RetentionDryRunForm({ policies }: { policies: string[] }) {
  return (
    <ActionForm action={retentionDryRunAction} successMessage="Dry run recorded. See the run log below." className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1">
        <label htmlFor="policy" className="text-xs font-medium text-muted">Policy</label>
        <Select id="policy" name="policy" defaultValue="" className="min-w-64">
          <option value="">All policies</option>
          {policies.map((p) => <option key={p} value={p}>{p}</option>)}
        </Select>
      </div>
      <SubmitButton variant="outline">Run dry-run (no deletion)</SubmitButton>
    </ActionForm>
  );
}

export function NomineeDecisionForm({ id, canVerify }: { id: string; canVerify: boolean }) {
  return (
    <ActionForm action={decideNomineeAction} successMessage="Decision recorded." confirm="Record this decision?" className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <label htmlFor={`nd-${id}`} className="text-xs font-medium text-muted">Documents checked offline / reason (required, kept on the record)</label>
      <Textarea id={`nd-${id}`} name="note" maxLength={1000} required className="min-h-20" />
      <div className="flex gap-2">
        {canVerify ? <SubmitButton name="decision" value="verified" size="sm">Verify nominee</SubmitButton> : null}
        <SubmitButton name="decision" value="rejected" variant="danger" size="sm">Reject</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function NomineeCompleteForm({ id }: { id: string }) {
  return (
    <ActionForm action={completeNomineeAction} successMessage="Request completed." confirm="Complete this request? Erasing the account cannot be undone." className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <label htmlFor={`nc-action-${id}`} className="text-xs font-medium text-muted">Action taken</label>
      <Select id={`nc-action-${id}`} name="action" defaultValue="release_export" className="max-w-xs">
        <option value="release_export">Release a copy of the data to the nominee</option>
        <option value="correct">Correct data as asked</option>
        <option value="erase_account">Erase the account</option>
        <option value="other">Other</option>
      </Select>
      <label htmlFor={`nc-note-${id}`} className="text-xs font-medium text-muted">What was done (kept on the record)</label>
      <Textarea id={`nc-note-${id}`} name="note" maxLength={1000} required className="min-h-20" />
      <SubmitButton size="sm">Complete request</SubmitButton>
    </ActionForm>
  );
}
