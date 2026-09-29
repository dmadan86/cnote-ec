"use client";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { replayDeadLetterAction } from "./actions";

export function ReplayButton({ topic, id }: { topic: string; id: string }) {
  return (
    <ActionForm action={replayDeadLetterAction} confirm="Replay this job? It will be processed again." successMessage="Queued for replay.">
      <input type="hidden" name="topic" value={topic} />
      <input type="hidden" name="id" value={id} />
      <SubmitButton size="sm" variant="outline" aria-label={`Replay job ${id}`}>Replay</SubmitButton>
    </ActionForm>
  );
}
