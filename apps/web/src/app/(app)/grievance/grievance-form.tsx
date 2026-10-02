"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Field, Input, Select, Textarea } from "@cnote/ui";
import { useLocale, useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { useConsentId } from "@/features/consent/consent-record";
import { formatDate, isLocale } from "@/i18n/config";
import { fileGrievanceAction, type FiledGrievance } from "./actions";

/** Data-principal rights (DPDP Act ss.11-14, s.6(4)) first, then a general complaint. Mirrors REQUEST_TYPES in @cnote/compliance. */
const REQUEST_TYPES = ["access", "correction", "erasure", "nomination", "withdraw_consent", "complaint"] as const;
/** What a general complaint can be about (the Grievance Officer's routing category). */
const COMPLAINT_CATEGORIES = ["consent", "content", "other"] as const;

export function GrievanceForm({ signedIn, email, ackHours }: { signedIn: boolean; email: string | null; ackHours: number }) {
  const t = useTranslations("grievance");
  const l = useLocale();
  const locale = isLocale(l) ? l : "en";
  const [state, action, pending] = useActionState<ActionResult<FiledGrievance> | null, FormData>(fileGrievanceAction, null);
  const [requestType, setRequestType] = useState("");
  // Prefilled from this browser's cookie consent record; the person can clear or replace it.
  const cookieConsentId = useConsentId();
  const [typedConsentId, setTypedConsentId] = useState<string | null>(null);
  const consentId = typedConsentId ?? cookieConsentId ?? "";
  const fe = (k: string) => (state && !state.ok ? state.fieldErrors?.[k] : undefined);
  if (state?.ok) {
    return (
      <Alert tone="success">
        <p className="font-semibold">{t("received")}</p>
        <p className="mt-1">
          {t.rich("receivedBody", { id: state.data.id, hours: ackHours, date: formatDate(state.data.dueAt, locale, { dateStyle: "long" }), code: (c) => <code className="break-all">{c}</code> })}{" "}
          {signedIn ? t("followSignedIn") : t("followAnon")}
        </p>
        {state.data.verificationRequired ? <p className="mt-2 font-medium">{t("verifyEmailSent")}</p> : null}
      </Alert>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      {state && !state.ok && !state.fieldErrors ? <Alert tone="danger">{state.error}</Alert> : null}
      <Field label={t("requestType")} htmlFor="requestType" error={fe("requestType")}>
        <Select id="requestType" name="requestType" value={requestType} onChange={(e) => setRequestType(e.target.value)} required>
          <option value="" disabled>{t("chooseRequestType")}</option>
          {REQUEST_TYPES.map((r) => <option key={r} value={r}>{t(`type.${r}`)}</option>)}
        </Select>
      </Field>
      {requestType === "complaint" ? (
        <Field label={t("complaintCategory")} htmlFor="category" error={fe("category")}>
          <Select id="category" name="category" defaultValue="" required>
            <option value="" disabled>{t("chooseCategory")}</option>
            {COMPLAINT_CATEGORIES.map((c) => <option key={c} value={c}>{t(`cat.${c}`)}</option>)}
          </Select>
        </Field>
      ) : null}
      <Field label={t("emailLabel")} htmlFor="contactEmail" hint={signedIn ? t("emailHintSignedIn") : t("emailHintAnon")} error={fe("contactEmail")}>
        <Input id="contactEmail" name="contactEmail" type="email" autoComplete="email" defaultValue={email ?? ""} required={!signedIn} />
      </Field>
      <Field label={t("subject")} htmlFor="subject" error={fe("subject")}>
        <Input id="subject" name="subject" maxLength={200} required />
      </Field>
      <Field label={t("describe")} htmlFor="body" hint={t("describeHint")} error={fe("body")}>
        <Textarea id="body" name="body" rows={6} maxLength={5000} required />
      </Field>
      <Field label={t("consentId")} htmlFor="consentId" hint={t("consentIdHint")} error={fe("consentId")}>
        <Input id="consentId" name="consentId" value={consentId} onChange={(e) => setTypedConsentId(e.target.value)} maxLength={32} autoComplete="off" spellCheck={false} className="font-mono" />
      </Field>
      <div><Button type="submit" size="lg" disabled={pending}>{pending ? t("submitting") : t("submit")}</Button></div>
    </form>
  );
}
