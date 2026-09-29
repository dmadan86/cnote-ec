"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Field, Input, Select } from "@cnote/ui";
import { useActionState } from "react";
import {
  createBuyerBusinessAction, deleteAccountAction, requestOtpAction, saveConsentsAction, updateProfileAction, verifyOtpAction,
} from "./actions";
import { INDIAN_STATES, LANGUAGES } from "./states";

type State = ActionResult | null;
const fe = (s: { ok: boolean; fieldErrors?: Record<string, string> } | null, k: string) => (s && !s.ok ? s.fieldErrors?.[k] : undefined);

function Result({ state, success }: { state: State; success?: string }) {
  if (!state) return null;
  if (state.ok) return success ? <Alert tone="success">{success}</Alert> : null;
  return state.fieldErrors ? null : <Alert tone="danger">{state.error}</Alert>;
}

export function OnboardingForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<State, FormData>(createBuyerBusinessAction, null);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="next" value={next} />
      <Result state={state} />
      <Field label="Business name" htmlFor="name" error={fe(state, "name")}>
        <Input id="name" name="name" autoComplete="organization" required />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="City" htmlFor="city" error={fe(state, "city")}>
          <Input id="city" name="city" autoComplete="address-level2" required />
        </Field>
        <Field label="Pincode" htmlFor="pincode" error={fe(state, "pincode")}>
          <Input id="pincode" name="pincode" inputMode="numeric" maxLength={6} autoComplete="postal-code" required />
        </Field>
      </div>
      <Field label="State" htmlFor="state" error={fe(state, "state")}>
        <Select id="state" name="state" defaultValue="" required>
          <option value="" disabled>Select state</option>
          {INDIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
      </Field>
      <Button type="submit" size="lg" disabled={pending}>{pending ? "Saving…" : "Continue"}</Button>
    </form>
  );
}

export function ProfileForm({ name, preferredLanguage, email }: { name: string | null; preferredLanguage: string; email: string | null }) {
  const [state, action, pending] = useActionState<State, FormData>(updateProfileAction, null);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <Result state={state} success="Profile saved." />
      <Field label="Email" htmlFor="email"><Input id="email" value={email ?? ""} disabled readOnly /></Field>
      <Field label="Name" htmlFor="name" error={fe(state, "name")}>
        <Input id="name" name="name" defaultValue={name ?? ""} autoComplete="name" required />
      </Field>
      <Field label="Preferred language" htmlFor="preferredLanguage" error={fe(state, "preferredLanguage")}>
        <Select id="preferredLanguage" name="preferredLanguage" defaultValue={preferredLanguage}>
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
        </Select>
      </Field>
      <div><Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save changes"}</Button></div>
    </form>
  );
}

export function PhoneVerification({ phone, verified }: { phone: string | null; verified: boolean }) {
  const [req, requestAction, requesting] = useActionState<ActionResult<{ phone: string; devCode?: string }> | null, FormData>(requestOtpAction, null);
  const [ver, verifyAction, verifying] = useActionState<State, FormData>(verifyOtpAction, null);
  const sent = req?.ok ? req.data : null;
  if (verified) return <Alert tone="success">Phone verified: {phone}</Alert>;
  return (
    <div className="flex flex-col gap-4">
      <form action={requestAction} className="flex flex-col gap-3" noValidate>
        <Result state={req && !req.ok ? req : null} />
        <Field label="Mobile number" htmlFor="phone" hint="Include the country code, e.g. +91 98765 43210." error={fe(req, "phone")}>
          <Input id="phone" name="phone" type="tel" autoComplete="tel" defaultValue={sent?.phone ?? phone ?? ""} required />
        </Field>
        <div><Button type="submit" variant="outline" disabled={requesting}>{requesting ? "Sending…" : sent ? "Resend code" : "Send code"}</Button></div>
      </form>
      {sent ? (
        <form action={verifyAction} className="flex flex-col gap-3" noValidate>
          <input type="hidden" name="phone" value={sent.phone} />
          {sent.devCode ? <Alert tone="info">Dev mode: your code is <strong className="font-mono">{sent.devCode}</strong></Alert> : null}
          <Result state={ver} success="Phone verified." />
          <Field label="6-digit code" htmlFor="code" error={fe(ver, "code")}>
            <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required />
          </Field>
          <div><Button type="submit" disabled={verifying}>{verifying ? "Verifying…" : "Verify"}</Button></div>
        </form>
      ) : null}
    </div>
  );
}

const CONSENT_COPY: Record<string, { title: string; body: string }> = {
  matching: { title: "Enquiry matching", body: "Share my enquiries with matching sellers so they can respond." },
  marketing: { title: "Product updates and offers", body: "Send me news and promotions by email." },
  voice_retention: { title: "Voice note retention", body: "Keep my voice recordings to improve transcription and support." },
  counterparty_sharing: { title: "Share contact with matched sellers", body: "Let a seller see my contact details once they accept my lead." },
};

export function ConsentForm({ consents }: { consents: Record<string, boolean> }) {
  const [state, action, pending] = useActionState<State, FormData>(saveConsentsAction, null);
  return (
    <form action={action} className="flex flex-col gap-4">
      <Result state={state} success="Preferences saved." />
      {Object.entries(CONSENT_COPY).map(([purpose, c]) => (
        <label key={purpose} className="flex items-start gap-3 text-sm">
          <input type="checkbox" name={`consent_${purpose}`} defaultChecked={consents[purpose]} className="mt-0.5 size-4" />
          <span><span className="block font-medium text-ink">{c.title}</span><span className="text-muted">{c.body}</span></span>
        </label>
      ))}
      <div><Button type="submit" disabled={pending}>{pending ? "Saving…" : "Save preferences"}</Button></div>
    </form>
  );
}

export function DeleteAccountForm() {
  const [state, action, pending] = useActionState<State, FormData>(deleteAccountAction, null);
  return (
    <form action={action} className="flex flex-col gap-3" noValidate>
      <p className="text-sm text-muted">
        This erases your personal details, signs you out everywhere and cannot be undone. Business and enquiry records are kept in anonymised form.
      </p>
      <Result state={state} />
      <Field label="Type DELETE to confirm" htmlFor="confirm" error={fe(state, "confirm")}>
        <Input id="confirm" name="confirm" autoComplete="off" />
      </Field>
      <div><Button type="submit" variant="danger" disabled={pending}>{pending ? "Deleting…" : "Delete my account"}</Button></div>
    </form>
  );
}
