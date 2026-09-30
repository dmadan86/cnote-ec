"use client";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { replayCallbackAction } from "./actions";

export function ReplayButton({ id }: { id: string }) {
  return (
    <ActionForm action={replayCallbackAction} confirm="Send this callback again?" successMessage="Queued for delivery.">
      <input type="hidden" name="id" value={id} />
      <SubmitButton size="sm" variant="outline" aria-label={`Replay callback ${id}`}>Replay</SubmitButton>
    </ActionForm>
  );
}
