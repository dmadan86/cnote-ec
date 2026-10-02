"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Alert, Textarea } from "@cnote/ui";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import { answerQuestionAction, type AnswerResult } from "./actions";

export function AnswerForm({ id, existing }: { id: string; existing?: boolean }) {
  const t = useTranslations("questions");
  const [state, action] = useActionState<AnswerResult | null, FormData>(answerQuestionAction, null);
  const err = fieldError(state, "body");
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <label htmlFor={`ans-${id}`} className="text-sm font-medium text-ink">{existing ? t("editLabel") : t("answerLabel")}</label>
      <Textarea id={`ans-${id}`} name="body" required minLength={2} maxLength={1000} aria-invalid={err ? true : undefined} aria-describedby={err ? `ans-${id}-err ans-${id}-hint` : `ans-${id}-hint`} className="min-h-20 text-base" />
      <p id={`ans-${id}-hint`} className="text-xs text-muted">{t("hint")}</p>
      {err ? <p id={`ans-${id}-err`} className="text-xs text-danger">{err}</p> : null}
      <FormAlert state={state} />
      {state?.ok ? (
        <div role="status" className="space-y-1">
          <Alert tone="success">{t("thanks")}</Alert>
          {state.data.stripped ? <Alert tone="info">{t("stripped")}</Alert> : null}
        </div>
      ) : null}
      <SubmitButton size="sm" pendingText={t("sending")}>{existing ? t("editBtn") : t("sendBtn")}</SubmitButton>
    </form>
  );
}
