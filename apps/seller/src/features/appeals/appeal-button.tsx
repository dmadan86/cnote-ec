"use client";
import { Alert, Button, Field, Textarea } from "@cnote/ui";
import { useActionState, useId } from "react";
import { useTranslations } from "next-intl";
import { fileAppealAction, type AppealResult } from "./actions";

export type AppealSubjectType = "listing_version" | "listing_image" | "review" | "comment" | "storefront_version";

/**
 * "Appeal this decision" entry point. Mount it next to any REJECTED listing version, listing image, review/comment or
 * storefront version, passing the id of the rejected item. It is a disclosure (details/summary) so it needs no JS to open.
 */
export function AppealDecision({ subjectType, subjectId, label }: { subjectType: AppealSubjectType; subjectId: string; label?: string }) {
  const [state, action, pending] = useActionState<AppealResult | null, FormData>(fileAppealAction, null);
  const t = useTranslations("appeals.button");
  const uid = useId();
  if (state?.ok) return <Alert tone="success">{t.rich("sent", { link: (c) => <a className="underline" href="/appeals">{c}</a> })}</Alert>;
  const reasonError = state && !state.ok ? state.fieldErrors?.reason : undefined;
  return (
    <details className="rounded-lg border border-line bg-surface p-3 text-sm">
      <summary className="cursor-pointer font-medium text-brand-700">{label ?? t("label")}</summary>
      <form action={action} className="mt-3 flex flex-col gap-3" noValidate>
        <input type="hidden" name="subjectType" value={subjectType} />
        <input type="hidden" name="subjectId" value={subjectId} />
        {state && !state.ok && !state.fieldErrors ? <Alert tone="danger">{state.error}</Alert> : null}
        <Field label={t("why")} htmlFor={`${uid}-reason`} hint={t("hint")} error={reasonError}>
          <Textarea id={`${uid}-reason`} name="reason" rows={4} maxLength={2000} required />
        </Field>
        <div><Button type="submit" size="sm" disabled={pending}>{pending ? t("sending") : t("send")}</Button></div>
      </form>
    </details>
  );
}
