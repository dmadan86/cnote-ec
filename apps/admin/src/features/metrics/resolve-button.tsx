"use client";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { resolveAlertAction } from "./actions";

export function ResolveAlertButton({ id, label }: { id: string; label: string }) {
  return (
    <ActionForm action={resolveAlertAction} confirm="Mark this alert as resolved?" successMessage="Resolved.">
      <input type="hidden" name="id" value={id} />
      <SubmitButton size="sm" variant="outline" aria-label={`Resolve alert: ${label}`}>Resolve</SubmitButton>
    </ActionForm>
  );
}
