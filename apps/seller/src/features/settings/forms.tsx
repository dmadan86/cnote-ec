"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Alert, Field, Input, Select } from "@cnote/ui";
import type { ConsentPurpose } from "@cnote/identity";
import { LANGUAGES } from "@/lib/constants";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import { ConsentFields } from "./consent-fields";
import { updateConsentsAction, updateProfileAction, type SettingsResult } from "./actions";

export function ProfileForm({ name, language, email }: { name: string; language: string; email: string | null }) {
  const t = useTranslations("settings.profile");
  const [state, action] = useActionState<SettingsResult | null, FormData>(updateProfileAction, null);
  return (
    <form action={action} className="space-y-4">
      <Field label={t("name")} htmlFor="name" error={fieldError(state, "name")}>
        <Input id="name" name="name" defaultValue={name} required className="h-11" autoComplete="name" />
      </Field>
      {email ? <p className="text-sm text-muted">{t("signedInAs", { email })}</p> : null}
      <Field label={t("language")} htmlFor="preferredLanguage" hint={t("languageHint")} error={fieldError(state, "preferredLanguage")}>
        <Select id="preferredLanguage" name="preferredLanguage" defaultValue={language} className="h-11">
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.native} ({l.label})</option>)}
        </Select>
      </Field>
      <FormAlert state={state} />
      {state?.ok ? <Alert tone="success">{t("saved")}</Alert> : null}
      <SubmitButton>{t("save")}</SubmitButton>
    </form>
  );
}

export function ConsentForm({ granted }: { granted: Partial<Record<ConsentPurpose, boolean>> }) {
  const t = useTranslations("settings.consents");
  const [state, action] = useActionState<SettingsResult | null, FormData>(updateConsentsAction, null);
  return (
    <form action={action} className="space-y-4">
      <ConsentFields granted={granted} />
      <FormAlert state={state} />
      {state?.ok ? <Alert tone="success">{t("saved")}</Alert> : null}
      <SubmitButton>{t("save")}</SubmitButton>
    </form>
  );
}
