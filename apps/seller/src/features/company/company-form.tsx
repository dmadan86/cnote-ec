"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Field, Input, Select } from "@cnote/ui";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import { saveCompanyAction, type CompanyFormResult } from "./actions";
import { CheckResults } from "./checks";

export interface CompanyDefaults {
  legalName?: string | null;
  tradeName?: string | null;
  companyType?: string | null;
  cin?: string | null;
  panMasked?: string | null;
  gstin?: string | null;
  website?: string | null;
  line1?: string; line2?: string; city?: string; stateCode?: string; pincode?: string;
}

const TYPES = ["proprietorship", "partnership", "llp", "private_limited", "public_limited", "huf", "other"] as const;

/** Company details + GSTIN in one form; shows the result of every verification check. */
export function CompanyForm({
  mode, states, defaults = {}, submitLabel,
}: { mode: "onboarding" | "portal"; states: { code: string; name: string }[]; defaults?: CompanyDefaults; submitLabel?: string }) {
  const t = useTranslations("settings.company.form");
  const [state, action] = useActionState<CompanyFormResult | null, FormData>(saveCompanyAction, null);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="mode" value={mode} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("legalName")} htmlFor="legalName" hint={t("legalHint")} error={fieldError(state, "legalName")}>
          <Input id="legalName" name="legalName" required defaultValue={defaults.legalName ?? ""} className="h-11" />
        </Field>
        <Field label={t("tradeName")} htmlFor="tradeName" error={fieldError(state, "tradeName")}>
          <Input id="tradeName" name="tradeName" defaultValue={defaults.tradeName ?? ""} className="h-11" />
        </Field>
        <Field label={t("type")} htmlFor="companyType" error={fieldError(state, "companyType")}>
          <Select id="companyType" name="companyType" required defaultValue={defaults.companyType ?? ""} className="h-11">
            <option value="" disabled>{t("typePick")}</option>
            {TYPES.map((v) => <option key={v} value={v}>{t(`types.${v}`)}</option>)}
          </Select>
        </Field>
        <Field label={t("gstin")} htmlFor="gstin" hint={t("gstinHint")} error={fieldError(state, "gstin")}>
          <Input id="gstin" name="gstin" defaultValue={defaults.gstin ?? ""} maxLength={15} autoCapitalize="characters" autoComplete="off" spellCheck={false} className="h-11 font-mono tracking-wider" />
        </Field>
        <Field label={t("pan")} htmlFor="pan" hint={defaults.panMasked ? t("panSaved", { pan: defaults.panMasked }) : t("panHint")} error={fieldError(state, "pan")}>
          <Input id="pan" name="pan" maxLength={10} autoCapitalize="characters" autoComplete="off" spellCheck={false} className="h-11 font-mono tracking-wider" />
        </Field>
        <Field label={t("cin")} htmlFor="cin" error={fieldError(state, "cin")}>
          <Input id="cin" name="cin" defaultValue={defaults.cin ?? ""} maxLength={21} autoCapitalize="characters" autoComplete="off" spellCheck={false} className="h-11 font-mono" />
        </Field>
      </div>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-ink">{t("address")}</legend>
        <Field label={t("line1")} htmlFor="line1" error={fieldError(state, "registeredAddress")}>
          <Input id="line1" name="line1" required defaultValue={defaults.line1 ?? ""} autoComplete="address-line1" className="h-11" />
        </Field>
        <Field label={t("line2")} htmlFor="line2">
          <Input id="line2" name="line2" defaultValue={defaults.line2 ?? ""} autoComplete="address-line2" className="h-11" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t("city")} htmlFor="city"><Input id="city" name="city" required defaultValue={defaults.city ?? ""} autoComplete="address-level2" className="h-11" /></Field>
          <Field label={t("state")} htmlFor="stateCode">
            <Select id="stateCode" name="stateCode" required defaultValue={defaults.stateCode ?? ""} className="h-11">
              <option value="" disabled>{t("statePick")}</option>
              {states.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label={t("pincode")} htmlFor="pincode"><Input id="pincode" name="pincode" required inputMode="numeric" maxLength={6} defaultValue={defaults.pincode ?? ""} autoComplete="postal-code" className="h-11" /></Field>
        </div>
      </fieldset>
      <Field label={t("website")} htmlFor="website" error={fieldError(state, "website")}>
        <Input id="website" name="website" type="url" defaultValue={defaults.website ?? ""} placeholder="https://" className="h-11" />
      </Field>
      <FormAlert state={state} />
      {state?.ok ? <CheckResults result={state.data} /> : null}
      <SubmitButton size="lg" pendingText={t("pending")}>{submitLabel ?? t("submit")}</SubmitButton>
    </form>
  );
}
