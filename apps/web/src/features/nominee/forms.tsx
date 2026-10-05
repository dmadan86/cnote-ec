"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Field, Input, Select, Textarea } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { fileNomineeRequestAction, revokeNomineeAction, saveNomineeAction, type FiledNomineeRequest } from "./actions";

type State = ActionResult | null;
const fe = (s: { ok: boolean; fieldErrors?: Record<string, string> } | null, k: string) => (s && !s.ok ? s.fieldErrors?.[k] : undefined);
const RELATIONSHIPS = ["spouse", "child", "parent", "sibling", "other_family", "legal_guardian", "friend", "other"] as const;

function Result({ state, success }: { state: { ok: boolean; error?: string; errorKey?: string; errorParams?: Record<string, string | number>; fieldErrors?: Record<string, string> } | null; success?: string }) {
  const te = useTranslations("errors");
  if (!state) return null;
  if (state.ok) return success ? <Alert tone="success">{success}</Alert> : null;
  return state.fieldErrors ? null : <Alert tone="danger">{state.errorKey && te.has(state.errorKey) ? te(state.errorKey, state.errorParams) : state.error}</Alert>;
}

/** Step-up fields: the same pair the account-erasure form uses (password, or an authenticator code when MFA is on). */
function StepUp({ idPrefix, state }: { idPrefix: string; state: State }) {
  const t = useTranslations("nominee");
  return (
    <>
      <p className="text-sm text-muted">{t("stepUp")}</p>
      <Field label={t("password")} htmlFor={`${idPrefix}-password`} error={fe(state, "password")}>
        <Input id={`${idPrefix}-password`} name="password" type="password" autoComplete="current-password" />
      </Field>
      <Field label={t("mfa")} htmlFor={`${idPrefix}-mfa`} error={fe(state, "mfaCode")}>
        <Input id={`${idPrefix}-mfa`} name="mfaCode" autoComplete="one-time-code" inputMode="numeric" />
      </Field>
    </>
  );
}

/** Add (no `nominee`) or change a nominee. */
export function NomineeForm({ nominee }: { nominee?: { id: string; name: string; relationship: string; contact: string } }) {
  const t = useTranslations("nominee");
  const [state, action, pending] = useActionState<State, FormData>(saveNomineeAction, null);
  const p = nominee ? `n-${nominee.id.slice(0, 8)}` : "n-new";
  return (
    <form action={action} className="flex flex-col gap-3" noValidate>
      {nominee ? <input type="hidden" name="id" value={nominee.id} /> : null}
      <Result state={state} success={t("saved")} />
      <Field label={t("name")} htmlFor={`${p}-name`} error={fe(state, "name")}>
        <Input id={`${p}-name`} name="name" autoComplete="off" defaultValue={nominee?.name} required maxLength={120} />
      </Field>
      <Field label={t("relationship")} htmlFor={`${p}-rel`} error={fe(state, "relationship")}>
        <Select id={`${p}-rel`} name="relationship" defaultValue={nominee?.relationship ?? "spouse"}>
          {RELATIONSHIPS.map((r) => <option key={r} value={r}>{t(`rel.${r}`)}</option>)}
        </Select>
      </Field>
      <Field label={t("contact")} htmlFor={`${p}-contact`} error={fe(state, "contact")}>
        <Input id={`${p}-contact`} name="contact" autoComplete="off" defaultValue={nominee?.contact} required maxLength={200} />
      </Field>
      <StepUp idPrefix={p} state={state} />
      <div><Button type="submit" disabled={pending}>{nominee ? t("save") : t("add")}</Button></div>
    </form>
  );
}

export function RevokeNomineeForm({ id }: { id: string }) {
  const t = useTranslations("nominee");
  const [state, action, pending] = useActionState<State, FormData>(revokeNomineeAction, null);
  const p = `r-${id.slice(0, 8)}`;
  return (
    <form action={action} className="flex flex-col gap-3" noValidate>
      <input type="hidden" name="id" value={id} />
      <Result state={state} success={t("removed")} />
      <StepUp idPrefix={p} state={state} />
      <div><Button type="submit" variant="danger" disabled={pending}>{t("revoke")}</Button></div>
    </form>
  );
}

/** Public: a nominee asks to act for the account holder. Shows the same confirmation whatever exists. */
export function NomineeRequestForm() {
  const t = useTranslations("nominee");
  const [state, action, pending] = useActionState<ActionResult<FiledNomineeRequest> | null, FormData>(fileNomineeRequestAction, null);
  if (state?.ok) {
    return (
      <div role="status" className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-ink">{t("receivedTitle")}</h2>
        <p className="text-sm text-muted">{t("receivedBody", { id: state.data.id, days: state.data.days })}</p>
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <Result state={state} />
      <Field label={t("principalEmail")} htmlFor="nr-principal" error={fe(state, "principalEmail")}>
        <Input id="nr-principal" name="principalEmail" type="email" autoComplete="off" required />
      </Field>
      <Field label={t("yourName")} htmlFor="nr-name" error={fe(state, "requesterName")}>
        <Input id="nr-name" name="requesterName" autoComplete="name" required maxLength={120} />
      </Field>
      <Field label={t("yourContact")} htmlFor="nr-contact" error={fe(state, "requesterContact")}>
        <Input id="nr-contact" name="requesterContact" autoComplete="email" required maxLength={200} />
      </Field>
      <Field label={t("ground")} htmlFor="nr-ground" error={fe(state, "ground")}>
        <Select id="nr-ground" name="ground" defaultValue="death">
          <option value="death">{t("groundDeath")}</option>
          <option value="incapacity">{t("groundIncapacity")}</option>
        </Select>
      </Field>
      <Field label={t("message")} htmlFor="nr-message" error={fe(state, "message")}>
        <Textarea id="nr-message" name="message" required maxLength={3000} className="min-h-28" />
      </Field>
      <div><Button type="submit" disabled={pending}>{pending ? t("sending") : t("submit")}</Button></div>
    </form>
  );
}
