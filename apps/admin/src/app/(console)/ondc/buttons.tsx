"use client";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Input, Select } from "@cnote/ui";
import { certItemAction, killSwitchAction, replayCallbackAction, resolveIssueAction } from "./actions";

export function ReplayButton({ id }: { id: string }) {
  return (
    <ActionForm action={replayCallbackAction} confirm="Send this callback again?" successMessage="Queued for delivery.">
      <input type="hidden" name="id" value={id} />
      <SubmitButton size="sm" variant="outline" aria-label={`Replay callback ${id}`}>Replay</SubmitButton>
    </ActionForm>
  );
}

export function KillSwitchForm({ killed }: { killed: boolean }) {
  return (
    <ActionForm action={killSwitchAction} confirm={killed ? "Resume ONDC traffic and queued callbacks?" : "Suspend ONDC now? All inbound requests will be NACKed and publishing stops."} successMessage={killed ? "ONDC resumed." : "ONDC suspended."}>
      <input type="hidden" name="killed" value={killed ? "false" : "true"} />
      <div className="flex flex-wrap items-center gap-2">
        <Input name="note" aria-label="Reason (kept in the audit log)" placeholder="Reason" className="h-9 w-72" maxLength={500} />
        <SubmitButton size="sm" variant={killed ? "primary" : "danger"}>{killed ? "Resume ONDC" : "Suspend ONDC (kill switch)"}</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function CertItemForm({ item, done }: { item: string; done: boolean }) {
  return (
    <ActionForm action={certItemAction} successMessage="Saved.">
      <input type="hidden" name="item" value={item} />
      <input type="hidden" name="done" value={done ? "false" : "true"} />
      <SubmitButton size="sm" variant="outline" aria-label={`${done ? "Unmark" : "Mark"} ${item}`}>{done ? "Unmark" : "Mark done"}</SubmitButton>
    </ActionForm>
  );
}

export function ResolveIssueForm({ id }: { id: string }) {
  return (
    <ActionForm action={resolveIssueAction} confirm="Resolve this issue and tell the buyer app?" successMessage="Resolved.">
      <input type="hidden" name="id" value={id} />
      <div className="flex flex-wrap items-center gap-2">
        <Select name="action" defaultValue="NO-ACTION" aria-label="Resolution" className="h-9 w-36 text-xs">
          <option value="NO-ACTION">No action</option><option value="REFUND">Refund</option><option value="REPLACEMENT">Replacement</option>
        </Select>
        <Input name="refundRupees" type="number" min={0} step="0.01" aria-label="Refund amount (rupees)" placeholder="Refund Rs" className="h-9 w-28" />
        <Input name="shortDesc" aria-label="Resolution note" placeholder="Resolution note" className="h-9 w-56" required minLength={5} maxLength={500} />
        <SubmitButton size="sm">Resolve</SubmitButton>
      </div>
    </ActionForm>
  );
}
