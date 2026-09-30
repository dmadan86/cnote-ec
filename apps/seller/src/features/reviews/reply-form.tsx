"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Alert, Textarea } from "@cnote/ui";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import { replyAction, type ReplyResult } from "./actions";

export function ReplyForm({ id, kind, existing }: { id: string; kind: "review" | "comment"; existing?: boolean }) {
  const t = useTranslations("reviews");
  const [state, action] = useActionState<ReplyResult | null, FormData>(replyAction, null);
  const err = fieldError(state, "body");
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="kind" value={kind} />
      <label htmlFor={`reply-${id}`} className="text-sm font-medium text-ink">{existing ? t("replaceLabel") : t("replyLabel")}</label>
      <Textarea id={`reply-${id}`} name="body" required minLength={2} maxLength={1000} aria-invalid={err ? true : undefined} aria-describedby={err ? `reply-${id}-err` : undefined} className="min-h-20 text-base" />
      {err ? <p id={`reply-${id}-err`} className="text-xs text-danger">{err}</p> : null}
      <FormAlert state={state} />
      {state?.ok ? <Alert tone="success">{t("thanks")}</Alert> : null}
      <SubmitButton size="sm" pendingText={t("sending")}>{existing ? t("replaceBtn") : t("sendBtn")}</SubmitButton>
    </form>
  );
}
