"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Textarea } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef } from "react";
import { sendMessageAction } from "./actions";

export function MessageForm({ conversationId }: { conversationId: string }) {
  const t = useTranslations("buyer");
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(sendMessageAction, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) ref.current?.reset();
  }, [state]);
  return (
    <form ref={ref} action={action} className="flex flex-col gap-2">
      <input type="hidden" name="conversationId" value={conversationId} />
      {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
      <label htmlFor="body" className="sr-only">{t("messageLabel")}</label>
      <Textarea id="body" name="body" required maxLength={4000} rows={3} placeholder={t("messagePlaceholder")} />
      <div>
        <Button type="submit" disabled={pending}>{pending ? t("sending") : t("send")}</Button>
      </div>
    </form>
  );
}
