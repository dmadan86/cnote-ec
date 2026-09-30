"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Field, Input, Select } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import {
  createBuyerBusinessAction, deleteAccountAction, requestOtpAction, saveConsentsAction, updateProfileAction, verifyOtpAction,
} from "./actions";
import { LOCALES, LOCALE_META, toLocale } from "@/i18n/config";
import { INDIAN_STATES, stateLabel } from "./states";

type State = ActionResult | null;
const fe = (s: { ok: boolean; fieldErrors?: Record<string, string> } | null, k: string) => (s && !s.ok ? s.fieldErrors?.[k] : undefined);

function Result({ state, success }: { state: State; success?: string }) {
  const te = useTranslations("errors");
  if (!state) return null;
  if (state.ok) return success ? <Alert tone="success">{success}</Alert> : null;
  // Known DomainError messages carry a stable key (packages/next-kit error-catalogue); unknown ones stay English.
  return state.fieldErrors ? null : <Alert tone="danger">{state.errorKey && te.has(state.errorKey) ? te(state.errorKey, state.errorParams) : state.error}</Alert>;
}

export function OnboardingForm({ next }: { next: string }) {
  const ts = useTranslations("states");
  const t = useTranslations("account");
  const [state, action, pending] = useActionState<State, FormData>(createBuyerBusinessAction, null);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="next" value={next} />
      <Result state={state} />
      <Field label={t("businessName")} htmlFor="name" error={fe(state, "name")}>
        <Input id="name" name="name" autoComplete="organization" required />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("city")} htmlFor="city" error={fe(state, "city")}>
          <Input id="city" name="city" autoComplete="address-level2" required />
        </Field>
        <Field label={t("pincode")} htmlFor="pincode" error={fe(state, "pincode")}>
          <Input id="pincode" name="pincode" inputMode="numeric" maxLength={6} autoComplete="postal-code" required />
        </Field>
      </div>
      <Field label={t("state")} htmlFor="state" error={fe(state, "state")}>
        <Select id="state" name="state" defaultValue="" required>
          <option value="" disabled>{t("selectState")}</option>
          {INDIAN_STATES.map((s) => <option key={s} value={s}>{stateLabel(s, (c) => (ts.has(c) ? ts(c) : undefined))}</option>)}
        </Select>
      </Field>
      <Button type="submit" size="lg" disabled={pending}>{pending ? t("saving") : t("continue")}</Button>
    </form>
  );
}

export function ProfileForm({ name, preferredLanguage, email }: { name: string | null; preferredLanguage: string; email: string | null }) {
  const t = useTranslations("account");
  const [state, action, pending] = useActionState<State, FormData>(updateProfileAction, null);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <Result state={state} success={t("profileSaved")} />
      <Field label={t("email")} htmlFor="email"><Input id="email" value={email ?? ""} disabled readOnly /></Field>
      <Field label={t("name")} htmlFor="name" error={fe(state, "name")}>
        <Input id="name" name="name" defaultValue={name ?? ""} autoComplete="name" required />
      </Field>
      <Field label={t("preferredLanguage")} htmlFor="preferredLanguage" error={fe(state, "preferredLanguage")}>
        <Select id="preferredLanguage" name="preferredLanguage" defaultValue={toLocale(preferredLanguage) ?? "en"}>
          {LOCALES.map((code) => <option key={code} value={code} lang={LOCALE_META[code].bcp47}>{LOCALE_META[code].native}</option>)}
        </Select>
      </Field>
      <div><Button type="submit" disabled={pending}>{pending ? t("saving") : t("saveChanges")}</Button></div>
    </form>
  );
}

export function PhoneVerification({ phone, verified }: { phone: string | null; verified: boolean }) {
  const t = useTranslations("account");
  const [req, requestAction, requesting] = useActionState<ActionResult<{ phone: string; devCode?: string }> | null, FormData>(requestOtpAction, null);
  const [ver, verifyAction, verifying] = useActionState<State, FormData>(verifyOtpAction, null);
  const sent = req?.ok ? req.data : null;
  if (verified) return <Alert tone="success">{t("phoneVerifiedAs", { phone: phone ?? "" })}</Alert>;
  return (
    <div className="flex flex-col gap-4">
      <form action={requestAction} className="flex flex-col gap-3" noValidate>
        <Result state={req && !req.ok ? req : null} />
        <Field label={t("mobile")} htmlFor="phone" hint={t("mobileHint")} error={fe(req, "phone")}>
          <Input id="phone" name="phone" type="tel" autoComplete="tel" defaultValue={sent?.phone ?? phone ?? ""} required />
        </Field>
        <div><Button type="submit" variant="outline" disabled={requesting}>{requesting ? t("sending") : sent ? t("resendCode") : t("sendCode")}</Button></div>
      </form>
      {sent ? (
        <form action={verifyAction} className="flex flex-col gap-3" noValidate>
          <input type="hidden" name="phone" value={sent.phone} />
          {sent.devCode ? <Alert tone="info">{t.rich("devCode", { code: sent.devCode, strong: (c) => <strong className="font-mono">{c}</strong> })}</Alert> : null}
          <Result state={ver} success={t("phoneVerifiedOk")} />
          <Field label={t("code")} htmlFor="code" error={fe(ver, "code")}>
            <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required />
          </Field>
          <div><Button type="submit" disabled={verifying}>{verifying ? t("verifying") : t("verify")}</Button></div>
        </form>
      ) : null}
    </div>
  );
}

// Purposes shown on the consent form; copy lives in the `account` namespace (consent.<purpose>.title/body).
const CONSENT_PURPOSE_KEYS = ["matching", "marketing", "voice_retention", "counterparty_sharing", "credit_underwriting"] as const;

export function ConsentForm({ consents }: { consents: Record<string, boolean> }) {
  const t = useTranslations("account");
  const [state, action, pending] = useActionState<State, FormData>(saveConsentsAction, null);
  return (
    <form action={action} className="flex flex-col gap-4">
      <Result state={state} success={t("prefsSaved")} />
      {CONSENT_PURPOSE_KEYS.map((purpose) => (
        <label key={purpose} className="flex items-start gap-3 text-sm">
          <input type="checkbox" name={`consent_${purpose}`} defaultChecked={consents[purpose]} className="mt-0.5 size-4" />
          <span><span className="block font-medium text-ink">{t(`consent.${purpose}.title`)}</span><span className="text-muted">{t(`consent.${purpose}.body`)}</span></span>
        </label>
      ))}
      <div><Button type="submit" disabled={pending}>{pending ? t("saving") : t("savePrefs")}</Button></div>
    </form>
  );
}

export function DeleteAccountForm() {
  const t = useTranslations("account");
  const [state, action, pending] = useActionState<State, FormData>(deleteAccountAction, null);
  return (
    <form action={action} className="flex flex-col gap-3" noValidate>
      <p className="text-sm text-muted">{t("deleteBody")}</p>
      <Result state={state} />
      <Field label={t("deleteConfirm")} htmlFor="confirm" error={fe(state, "confirm")}>
        <Input id="confirm" name="confirm" autoComplete="off" />
      </Field>
      <div><Button type="submit" variant="danger" disabled={pending}>{pending ? t("deleting") : t("deleteButton")}</Button></div>
    </form>
  );
}
