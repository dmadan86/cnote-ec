"use client";
import { Button, type ButtonProps } from "@cnote/ui";
import { useFormStatus } from "react-dom";

export function SubmitButton({ children, pendingText = "Saving…", ...rest }: ButtonProps & { pendingText?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || rest.disabled} aria-busy={pending} {...rest}>
      {pending ? pendingText : children}
    </Button>
  );
}
