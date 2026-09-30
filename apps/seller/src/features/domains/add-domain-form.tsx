"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Alert, Field, Input } from "@cnote/ui";
import { FormAlert, SubmitButton } from "@/features/shell/form-bits";
import { addDomainAction } from "./actions";
import type { ActionResult } from "@cnote/next-kit";

export function AddDomainForm({ disabled }: { disabled?: boolean }) {
  const t = useTranslations("storefront.form");
  const [state, action] = useActionState<ActionResult<null> | null, FormData>(addDomainAction, null);
  return (
    <form action={action} className="space-y-3" noValidate>
      <Field label={t("label")} htmlFor="hostname" hint={t("hint")}>
        <Input id="hostname" name="hostname" required inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="www.yourshop.in" disabled={disabled} className="text-base" />
      </Field>
      <FormAlert state={state} />
      {state?.ok ? <Alert tone="success">{t("success")}</Alert> : null}
      <SubmitButton pendingText={t("pending")} disabled={disabled}>{t("submit")}</SubmitButton>
    </form>
  );
}
