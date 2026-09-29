"use client";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { recheckDomainAction, removeDomainAction } from "./actions";

export function DomainRowActions({ id, hostname }: { id: string; hostname: string }) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <ActionForm action={recheckDomainAction} successMessage="Re-check queued.">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="hostname" value={hostname} />
        <SubmitButton size="sm" variant="outline" aria-label={`Force re-check ${hostname}`}>Re-check</SubmitButton>
      </ActionForm>
      <ActionForm action={removeDomainAction} confirm={`Remove ${hostname}? The seller's storefront will stop being served on it.`} successMessage="Removed.">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="hostname" value={hostname} />
        <SubmitButton size="sm" variant="danger" aria-label={`Remove ${hostname}`}>Remove</SubmitButton>
      </ActionForm>
    </div>
  );
}
