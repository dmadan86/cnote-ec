"use client";
import { useActionState, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Alert, Field, Input } from "@cnote/ui";
import { checkGstin, normalizeGstin } from "@/lib/gstin";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import { verifyGstinAction, type GstResult } from "./actions";

export function GstForm({ mode }: { mode: "onboarding" | "portal" }) {
  const [state, action] = useActionState<GstResult | null, FormData>(verifyGstinAction, null);
  const [gstin, setGstin] = useState("");
  const check = checkGstin(gstin);
  const touched = gstin.length > 0;
  const hint = !touched ? "15 characters, like 27AAPFU0939F1ZV. You can find it on your GST certificate." : check.ok ? "Format looks right." : check.message;

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="mode" value={mode} />
      <Field
        label="GSTIN"
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
      <Field label="Udyam registration (optional)" htmlFor="udyam" hint="For MSME status, like UDYAM-KA-03-0012345." error={fieldError(state, "udyam")}>
        <Input id="udyam" name="udyam" autoCapitalize="characters" autoComplete="off" className="h-11" />
      </Field>
      <FormAlert state={state} />
      {state?.ok && !state.data.passed ? (
        <Alert tone="warning">We could not verify this GSTIN. {state.data.reason ?? "Check the number matches your registration and try again."}</Alert>
      ) : null}
      {state?.ok && state.data.passed ? <Alert tone="success">GST verified. Your badge now shows GST verified.</Alert> : null}
      <SubmitButton size="lg" disabled={!check.ok} pendingText="Verifying…">
        Verify GST
      </SubmitButton>
    </form>
  );
}
