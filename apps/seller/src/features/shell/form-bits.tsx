"use client";
import { useFormStatus } from "react-dom";
import { Alert, Button, type ButtonProps } from "@cnote/ui";
import type { ActionResult } from "@cnote/next-kit";

export function SubmitButton({ children, pendingText = "Saving…", className, ...props }: ButtonProps & { pendingText?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className={`min-h-11 ${className ?? ""}`} {...props} disabled={pending || props.disabled} aria-busy={pending}>
      {pending ? pendingText : children}
    </Button>
  );
}

export function FormAlert({ state }: { state: ActionResult<unknown> | null }) {
  if (!state || state.ok) return null;
  return <Alert tone="danger">{state.error}</Alert>;
}

export function fieldError(state: ActionResult<unknown> | null, key: string): string | undefined {
  return state && !state.ok ? state.fieldErrors?.[key] : undefined;
}
