"use client";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { resetConversationAction, retryInboundAction } from "./actions";

export function ResetButton({ id }: { id: string }) {
  return (
    <ActionForm action={resetConversationAction} confirm="Reset this conversation to the start? The seller will be asked for a language again." successMessage="Conversation reset.">
      <input type="hidden" name="id" value={id} />
      <SubmitButton size="sm" variant="outline">Reset</SubmitButton>
    </ActionForm>
  );
}

export function RetryButton({ id }: { id: string }) {
  return (
    <ActionForm action={retryInboundAction} confirm="Retry this failed message?" successMessage="Queued for retry.">
      <input type="hidden" name="id" value={id} />
      <SubmitButton size="sm" variant="outline" aria-label={`Retry job ${id}`}>Retry</SubmitButton>
    </ActionForm>
  );
}
