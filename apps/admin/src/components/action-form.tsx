"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, type ButtonProps } from "@cnote/ui";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

export function SubmitButton({ children, ...rest }: ButtonProps) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || rest.disabled} {...rest}>
      {pending ? "Working…" : children}
    </Button>
  );
}

/** Wraps a server action returning ActionResult; shows the outcome inline. Optional native confirm() guard. */
export function ActionForm({
  action,
  children,
  confirm,
  className,
  successMessage = "Done.",
}: {
  action: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  children: React.ReactNode;
  confirm?: string;
  className?: string;
  successMessage?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      {state && !state.ok ? <Alert tone="danger" className="mt-3">{state.error}</Alert> : null}
      {state?.ok ? <Alert tone="success" className="mt-3">{successMessage}</Alert> : null}
    </form>
  );
}
