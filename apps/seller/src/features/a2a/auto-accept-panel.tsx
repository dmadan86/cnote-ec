"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Badge, Field, Input } from "@cnote/ui";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import { setAutoAcceptAction, type AgentResult } from "./actions";
import { paiseToRupeeText } from "./money";

/**
 * Auto-accept is OFF by default. Turning it on needs an explicit consent tick and the lowest price the agent may accept on
 * its own; turning it off is a single click (ADR-020). Even with it on, the agent can never go below the private floor.
 */
export function AutoAcceptPanel({ id, enabled, limitPaise, editable }: { id: string; enabled: boolean; limitPaise: number | null; editable: boolean }) {
  const t = useTranslations("a2a");
  const [state, act] = useActionState<AgentResult | null, FormData>(setAutoAcceptAction, null);
  const [offState, offAct] = useActionState<AgentResult | null, FormData>(setAutoAcceptAction, null);
  return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 text-sm">
        <Badge tone={enabled ? "warning" : "success"}>{enabled ? t("auto.on") : t("auto.off")}</Badge>
        <span className="text-muted">{enabled ? t("auto.onNote", { price: paiseToRupeeText(limitPaise) }) : t("auto.offNote")}</span>
      </p>
      {!editable ? null : enabled ? (
        <form action={offAct} className="space-y-2">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="enabled" value="off" />
          <SubmitButton variant="outline" pendingText={t("controls.working")}>{t("auto.turnOff")}</SubmitButton>
          <FormAlert state={offState} />
        </form>
      ) : (
        <form action={act} className="space-y-4">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="enabled" value="on" />
          <Field label={t("auto.limitLabel")} htmlFor={`aa-${id}-limit`} hint={t("auto.limitHint")} error={fieldError(state, "limit")}>
            <Input id={`aa-${id}-limit`} name="limit" inputMode="decimal" required className="h-11" />
          </Field>
          <div>
            <label className="flex min-h-11 items-start gap-2 text-sm">
              <input type="checkbox" name="consent" required className="mt-1 size-4 accent-brand-600" aria-describedby={fieldError(state, "consent") ? `aa-${id}-consent-err` : undefined} />
              <span>{t("auto.consent")}</span>
            </label>
            {fieldError(state, "consent") ? <p id={`aa-${id}-consent-err`} role="alert" className="text-xs text-danger">{fieldError(state, "consent")}</p> : null}
          </div>
          <FormAlert state={state} />
          <SubmitButton pendingText={t("controls.working")}>{t("auto.turnOn")}</SubmitButton>
        </form>
      )}
    </div>
  );
}
