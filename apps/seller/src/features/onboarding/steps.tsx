"use client";
import { useActionState } from "react";
import { Alert, Field, Input, Select } from "@cnote/ui";
import type { ActionResult } from "@cnote/next-kit";
import type { PlanView } from "@cnote/billing";
import type { ConsentPurpose } from "@cnote/identity";
import { LANGUAGES, STATES } from "@/lib/constants";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import { ConsentFields } from "@/features/settings/consent-fields";
import { Money } from "@cnote/ui";
import { createBusinessAction, finishOnboardingAction, requestOtpAction, skipStepAction, verifyOtpAction, type OtpSent } from "./actions";

export function BusinessStep() {
  const [state, action] = useActionState<ActionResult | null, FormData>(createBusinessAction, null);
  return (
    <form action={action} className="space-y-4">
      <Field label="Business name" htmlFor="name" error={fieldError(state, "name")}>
        <Input id="name" name="name" required autoComplete="organization" className="h-12 text-base" placeholder="Shree Packaging Co." />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="City" htmlFor="city" error={fieldError(state, "city")}>
          <Input id="city" name="city" required autoComplete="address-level2" className="h-12 text-base" />
        </Field>
        <Field label="State" htmlFor="state" error={fieldError(state, "state")}>
          <Select id="state" name="state" required defaultValue="" className="h-12 text-base">
            <option value="" disabled>Select state</option>
            {STATES.map((s) => <option key={s}>{s}</option>)}
          </Select>
        </Field>
        <Field label="Pincode" htmlFor="pincode" error={fieldError(state, "pincode")}>
          <Input id="pincode" name="pincode" required inputMode="numeric" maxLength={6} autoComplete="postal-code" className="h-12 text-base" />
        </Field>
      </div>
      <fieldset>
        <legend className="text-sm font-medium text-ink">Languages you talk to buyers in</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {LANGUAGES.map((l) => (
            <label key={l.code} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-line bg-surface px-3 text-sm has-checked:border-brand-600 has-checked:bg-brand-50">
              <input type="checkbox" name="languages" value={l.code} defaultChecked={l.code === "hi" || l.code === "en"} className="size-4 accent-brand-600" />
              {l.native}
            </label>
          ))}
        </div>
        {fieldError(state, "languages") ? <p className="mt-1 text-xs text-danger">{fieldError(state, "languages")}</p> : null}
      </fieldset>
      <FormAlert state={state} />
      <SubmitButton size="lg" pendingText="Saving…">Save and continue</SubmitButton>
    </form>
  );
}

export function PhoneStep({ initialPhone }: { initialPhone: string }) {
  const [sent, request] = useActionState<OtpSent | null, FormData>(requestOtpAction, null);
  const [verify, check] = useActionState<ActionResult | null, FormData>(verifyOtpAction, null);
  const phone = sent?.ok ? sent.data.phone : null;
  return (
    <div className="space-y-6">
      <form action={request} className="space-y-3">
        <Field label="Mobile number" htmlFor="phone" hint="We send a one-time code by SMS. Buyers see your number only after you accept their lead." error={fieldError(sent, "phone")}>
          <div className="flex gap-2">
            <span className="grid h-12 place-items-center rounded-lg border border-line bg-canvas px-3 text-sm text-muted">+91</span>
            <Input id="phone" name="phone" type="tel" inputMode="numeric" autoComplete="tel-national" defaultValue={initialPhone.replace(/^\+91/, "")} required className="h-12 text-base" />
          </div>
        </Field>
        <FormAlert state={sent} />
        <SubmitButton variant={phone ? "outline" : "primary"} size="lg" pendingText="Sending…">{phone ? "Send code again" : "Send code"}</SubmitButton>
      </form>

      {phone ? (
        <form action={check} className="space-y-3 border-t border-line pt-6">
          <input type="hidden" name="phone" value={phone} />
          <Field label={`Enter the code sent to ${phone}`} htmlFor="code" error={fieldError(verify, "code")}>
            <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={8} required className="h-12 max-w-48 text-center font-mono text-xl tracking-widest" />
          </Field>
          {sent?.ok && sent.data.devCode ? (
            <Alert tone="info">Development mode: your code is <strong className="font-mono">{sent.data.devCode}</strong></Alert>
          ) : null}
          <FormAlert state={verify} />
          <SubmitButton size="lg" pendingText="Checking…">Verify and continue</SubmitButton>
        </form>
      ) : null}
    </div>
  );
}

export function SkipButton({ step, children }: { step: "gst" | "listing"; children: React.ReactNode }) {
  return (
    <form action={skipStepAction}>
      <input type="hidden" name="step" value={step} />
      <SubmitButton variant="ghost" pendingText="One moment…">{children}</SubmitButton>
    </form>
  );
}

export function PlanStep({ plans, defaultPlan, granted }: { plans: PlanView[]; defaultPlan: string; granted: Partial<Record<ConsentPurpose, boolean>> }) {
  const [state, action] = useActionState<ActionResult | null, FormData>(finishOnboardingAction, null);
  return (
    <form action={action} className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-ink">Choose a plan</legend>
        {plans.length === 0 ? <Alert tone="info">Plans could not be loaded. You will start on the Free plan and can change it in Billing.</Alert> : null}
        {plans.map((p) => (
          <label key={p.code} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-card border border-line bg-surface p-4 has-checked:border-brand-600 has-checked:bg-brand-50">
            <input type="radio" name="planCode" value={p.code} defaultChecked={p.code === defaultPlan} className="mt-1 size-5 accent-brand-600" />
            <span className="flex-1">
              <span className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold text-ink">{p.name}</span>
                <span>{p.monthlyPricePaise === 0 ? <span className="font-bold text-ink">Free</span> : <Money paise={p.monthlyPricePaise} unit="month" />}</span>
              </span>
              <span className="block text-sm text-ink">{p.monthlyCredits} lead credits per month</span>
              <span className="block text-sm text-muted">{p.features.join(" · ")}</span>
            </span>
          </label>
        ))}
        <p className="text-xs text-muted">Free is the default. Paid plans start only if you pick them here, last one month, and never renew on their own. Your badge and rank do not depend on your plan.</p>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-ink">Your data choices</legend>
        <p className="text-sm text-muted">Tick only what you agree to. You can change these later in Settings.</p>
        <ConsentFields granted={granted} />
      </fieldset>
      <FormAlert state={state} />
      <SubmitButton size="lg" pendingText="Finishing…">Finish setup</SubmitButton>
    </form>
  );
}
