"use client";
import { useActionState, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Alert, Field, Input } from "@cnote/ui";
import { checkGstin, gstinChecksumChar, normalizeGstin } from "@/lib/gstin";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import { verifyGstinAction, type GstResult } from "./actions";

// Same structure test as lib/gstin.ts, only to pick which translated hint to show.
const GSTIN_SHAPE = /^(0[1-9]|[1-3][0-9])[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function GstForm({ mode }: { mode: "onboarding" | "portal" }) {
  const t = useTranslations("verification.gst");
  const [state, action] = useActionState<GstResult | null, FormData>(verifyGstinAction, null);
  const [gstin, setGstin] = useState("");
  const check = checkGstin(gstin);
  const touched = gstin.length > 0;
  const bad = (): string => {
    if (gstin.length < 15) return t("progress", { count: gstin.length });
    if (gstin.length > 15) return t("tooLong");
    if (!GSTIN_SHAPE.test(gstin)) return t("badPattern");
    return gstinChecksumChar(gstin.slice(0, 14)) !== gstin[14] ? t("badChecksum") : t("badPattern");
  };
  const hint = !touched ? t("hintEmpty") : check.ok ? t("hintOk") : bad();

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="mode" value={mode} />
      <Field
        label={t("label")}
        htmlFor="gstin"
        hint={
          <span className={touched && check.ok ? "text-success" : undefined} aria-live="polite">
            {touched && check.ok ? <CheckCircle2 className="mr-1 inline size-3.5" aria-hidden /> : null}
            {hint}
          </span>
        }
        error={fieldError(state, "gstin")}
      >
        <Input
          id="gstin"
          name="gstin"
          value={gstin}
          onChange={(e) => setGstin(normalizeGstin(e.target.value).slice(0, 15))}
          maxLength={15}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          required
          className="h-12 font-mono text-base tracking-wider"
          aria-invalid={touched && gstin.length === 15 && !check.ok}
        />
      </Field>
      <Field label={t("udyamLabel")} htmlFor="udyam" hint={t("udyamHint")} error={fieldError(state, "udyam")}>
        <Input id="udyam" name="udyam" autoCapitalize="characters" autoComplete="off" className="h-11" />
      </Field>
      <FormAlert state={state} />
      {state?.ok && !state.data.passed ? (
        <Alert tone="warning">{t("failed", { reason: state.data.reason ?? t("defaultReason") })}</Alert>
      ) : null}
      {state?.ok && state.data.passed ? <Alert tone="success">{t("passed")}</Alert> : null}
      <SubmitButton size="lg" disabled={!check.ok} pendingText={t("pending")}>
        {t("submit")}
      </SubmitButton>
    </form>
  );
}
