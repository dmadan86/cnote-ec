"use client";
import { Input, Textarea } from "@cnote/ui";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { recordAuditAction, requestAuditAction, scheduleAuditAction } from "./actions";

export function RequestAuditForm() {
  return (
    <ActionForm action={requestAuditAction} successMessage="Audit requested." className="flex flex-wrap items-end gap-2">
      <div><label htmlFor="ra-biz" className="block text-xs text-muted">Business ID</label><Input id="ra-biz" name="businessId" required placeholder="uuid" className="w-80 font-mono text-xs" /></div>
      <div><label htmlFor="ra-partner" className="block text-xs text-muted">Partner agency</label><Input id="ra-partner" name="partner" required maxLength={80} placeholder="e.g. SGS India" /></div>
      <SubmitButton size="sm">Request audit</SubmitButton>
    </ActionForm>
  );
}

export function ScheduleAuditForm({ id }: { id: string }) {
  return (
    <ActionForm action={scheduleAuditAction} successMessage="Scheduled." className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="id" value={id} />
      <label htmlFor={`sch-${id}`} className="sr-only">Audit date and time</label>
      <Input id={`sch-${id}`} name="when" type="datetime-local" required className="w-56" />
      <SubmitButton size="sm" variant="outline">Schedule</SubmitButton>
    </ActionForm>
  );
}

export function RecordAuditForm({ id }: { id: string }) {
  return (
    <ActionForm action={recordAuditAction} successMessage="Result recorded." className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <label htmlFor={`sum-${id}`} className="sr-only">Findings summary</label>
      <Textarea id={`sum-${id}`} name="summary" required maxLength={2000} placeholder="Findings summary" className="min-h-16" />
      <div className="flex flex-wrap items-end gap-2">
        <div><label htmlFor={`res-${id}`} className="block text-xs text-muted">Result</label>
          <select id={`res-${id}`} name="result" className="h-9 rounded-lg border border-line bg-surface px-2 text-sm"><option value="pass">Pass</option><option value="conditional">Conditional</option><option value="fail">Fail</option></select></div>
        <div><label htmlFor={`vu-${id}`} className="block text-xs text-muted">Valid until</label><Input id={`vu-${id}`} name="validUntil" type="date" required className="w-40" /></div>
        <div><label htmlFor={`rep-${id}`} className="block text-xs text-muted">Report (image, zip or PDF, up to 1 MB)</label><input id={`rep-${id}`} name="report" type="file" accept="image/*,application/zip,application/pdf" className="text-xs" /></div>
        <SubmitButton size="sm">Record result</SubmitButton>
      </div>
    </ActionForm>
  );
}
