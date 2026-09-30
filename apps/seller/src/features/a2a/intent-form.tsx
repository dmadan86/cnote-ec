"use client";
import { useActionState } from "react";
import type { ButtonVariant } from "@cnote/ui";
import { FormAlert, SubmitButton } from "@/features/shell/form-bits";
import type { AgentResult } from "./actions";

/** One-button form posting `id` + `intent` to a server action; shows the action error inline (role="alert"). */
export function IntentForm({
  action, id, intent, label, pendingText, variant = "outline", extra,
}: {
  action: (prev: AgentResult | null, fd: FormData) => Promise<AgentResult>;
  id: string;
  intent: string;
  label: string;
  pendingText: string;
  variant?: ButtonVariant;
  extra?: Record<string, string>;
}) {
  const [state, act] = useActionState<AgentResult | null, FormData>(action, null);
  return (
    <form action={act} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="intent" value={intent} />
      {Object.entries(extra ?? {}).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <SubmitButton variant={variant} pendingText={pendingText}>{label}</SubmitButton>
      <FormAlert state={state} />
    </form>
  );
}
