"use client";
import { useActionState } from "react";
import { Alert, Field, Input } from "@cnote/ui";
import { FormAlert, SubmitButton } from "@/features/shell/form-bits";
import { addDomainAction } from "./actions";
import type { ActionResult } from "@cnote/next-kit";

export function AddDomainForm({ disabled }: { disabled?: boolean }) {
  const [state, action] = useActionState<ActionResult<null> | null, FormData>(addDomainAction, null);
  return (
    <form action={action} className="space-y-3" noValidate>
      <Field label="Your domain" htmlFor="hostname" hint="For example www.yourshop.in or yourshop.in. No https:// needed.">
        <Input id="hostname" name="hostname" required inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="www.yourshop.in" disabled={disabled} className="text-base" />
      </Field>
      <FormAlert state={state} />
      {state?.ok ? <Alert tone="success">Domain added. Follow the steps below to point it at your storefront.</Alert> : null}
      <SubmitButton pendingText="Adding…" disabled={disabled}>Connect domain</SubmitButton>
    </form>
  );
}
