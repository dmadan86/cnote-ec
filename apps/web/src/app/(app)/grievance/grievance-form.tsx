"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Field, Input, Select, Textarea } from "@cnote/ui";
import { useLocale, useTranslations } from "next-intl";
import { useActionState } from "react";
import { formatDate, isLocale } from "@/i18n/config";
import { fileGrievanceAction, type FiledGrievance } from "./actions";

const CATEGORIES = ["access", "correction", "erasure", "consent", "content", "other"] as const;

export function GrievanceForm({ signedIn, email, ackHours }: { signedIn: boolean; email: string | null; ackHours: number }) {
  const t = useTranslations("grievance");
  const l = useLocale();
  const locale = isLocale(l) ? l : "en";
  const [state, action, pending] = useActionState<ActionResult<FiledGrievance> | null, FormData>(fileGrievanceAction, null);
  const fe = (k: string) => (state && !state.ok ? state.fieldErrors?.[k] : undefined);
  if (state?.ok) {
    return (
      <Alert tone="success">
        <p className="font-semibold">{t("received")}</p>
        <p className="mt-1">
          {t.rich("receivedBody", { id: state.data.id, hours: ackHours, date: formatDate(state.data.dueAt, locale, { dateStyle: "long" }), code: (c) => <code className="break-all">{c}</code> })}{" "}
          {signedIn ? t("followSignedIn") : t("followAnon")}
        </p>
      </Alert>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      {state && !state.ok && !state.fieldErrors ? <Alert tone="danger">{state.error}</Alert> : null}
      <Field label={t("category")} htmlFor="category" error={fe("category")}>
        <Select id="category" name="category" defaultValue="" required>
          <option value="" disabled>{t("chooseCategory")}</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{t(`cat.${c}`)}</option>)}
        </Select>
      </Field>
      <Field label={t("emailLabel")} htmlFor="contactEmail" hint={signedIn ? t("emailHintSignedIn") : t("emailHintAnon")} error={fe("contactEmail")}>
        <Input id="contactEmail" name="contactEmail" type="email" autoComplete="email" defaultValue={email ?? ""} required={!signedIn} />
      </Field>
      <Field label={t("subject")} htmlFor="subject" error={fe("subject")}>
        <Input id="subject" name="subject" maxLength={200} required />
      </Field>
      <Field label={t("describe")} htmlFor="body" hint={t("describeHint")} error={fe("body")}>
        <Textarea id="body" name="body" rows={6} maxLength={5000} required />
      </Field>
      <div><Button type="submit" size="lg" disabled={pending}>{pending ? t("submitting") : t("submit")}</Button></div>
    </form>
  );
}
