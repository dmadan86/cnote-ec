"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Button } from "@cnote/ui";
import { ActionForm } from "@/components/action-form";
import { useFormStatus } from "react-dom";

function Submit({ name }: { name: string }) {
  const { pending } = useFormStatus();
  return <Button type="submit" variant="danger" size="sm" disabled={pending} aria-label={`Revoke ${name}`}>{pending ? "Revoking…" : "Revoke"}</Button>;
}

export function RevokeKey({ id, name, action }: { id: string; name: string; action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult> }) {
  return (
    <ActionForm action={action} confirm={`Revoke "${name}"? Apps using it stop working immediately.`} successMessage="Revoked.">
      <input type="hidden" name="id" value={id} />
      <Submit name={name} />
    </ActionForm>
  );
}
