"use client";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Input, Select } from "@cnote/ui";
import { liftSuspensionAction, suspendAction } from "./actions";

/** Suspend by kind. Pass `fixed` to lock kind + target (row actions); otherwise staff type the id. */
export function SuspendForm({ fixed, label }: { fixed?: { kind: "mandate" | "business" | "api_key"; targetId: string }; label?: string }) {
  const uid = fixed ? `${fixed.kind}-${fixed.targetId}` : "generic";
  return (
    <ActionForm action={suspendAction} confirm="Suspend now? The agent activity stops immediately and open negotiations are withdrawn." successMessage="Suspended.">
      <div className="flex flex-wrap items-center gap-2">
        {fixed ? (
          <><input type="hidden" name="kind" value={fixed.kind} /><input type="hidden" name="targetId" value={fixed.targetId} /></>
        ) : (
          <>
            <Select name="kind" defaultValue="mandate" aria-label="What to suspend" className="h-9 w-40 text-xs">
              <option value="mandate">Mandate (id)</option><option value="business">Business agents (id)</option><option value="api_key">API key (key id)</option>
            </Select>
            <Input name="targetId" aria-label="Target id" placeholder="Id" className="h-9 w-72" required maxLength={200} />
          </>
        )}
        <Input name="reason" id={`reason-${uid}`} aria-label={`Reason (kept in the audit log)${label ? ` for ${label}` : ""}`} placeholder="Reason (min 5 chars)" className="h-9 w-64" required minLength={5} maxLength={500} />
        <SubmitButton size="sm" variant="danger">{label ?? "Suspend"}</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function LiftForm({ id }: { id: string }) {
  return (
    <ActionForm action={liftSuspensionAction} confirm="Lift this suspension?" successMessage="Suspension lifted.">
      <input type="hidden" name="id" value={id} />
      <div className="flex flex-wrap items-center gap-2">
        <Input name="reason" aria-label="Reason for lifting (kept in the audit log)" placeholder="Reason (min 5 chars)" className="h-9 w-52" required minLength={5} maxLength={500} />
        <SubmitButton size="sm" variant="outline">Lift</SubmitButton>
      </div>
    </ActionForm>
  );
}
