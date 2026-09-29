"use client";
import { useActionState } from "react";
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

const TYPES = [
  ["proprietorship", "Proprietorship"], ["partnership", "Partnership firm"], ["llp", "LLP"],
  ["private_limited", "Private Limited company"], ["public_limited", "Public Limited company"], ["huf", "HUF"], ["other", "Other"],
] as const;

/** Company details + GSTIN in one form; shows the result of every verification check. */
export function CompanyForm({
  mode, states, defaults = {}, submitLabel = "Save and verify",
}: { mode: "onboarding" | "portal"; states: { code: string; name: string }[]; defaults?: CompanyDefaults; submitLabel?: string }) {
  const [state, action] = useActionState<CompanyFormResult | null, FormData>(saveCompanyAction, null);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="mode" value={mode} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Legal name" htmlFor="legalName" hint="As on your GST certificate." error={fieldError(state, "legalName")}>
          <Input id="legalName" name="legalName" required defaultValue={defaults.legalName ?? ""} className="h-11" />
        </Field>
        <Field label="Trade name (optional)" htmlFor="tradeName" error={fieldError(state, "tradeName")}>
          <Input id="tradeName" name="tradeName" defaultValue={defaults.tradeName ?? ""} className="h-11" />
        </Field>
        <Field label="Company type" htmlFor="companyType" error={fieldError(state, "companyType")}>
          <Select id="companyType" name="companyType" required defaultValue={defaults.companyType ?? ""} className="h-11">
            <option value="" disabled>Select type</option>
            {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Field>
        <Field label="GSTIN" htmlFor="gstin" hint="15 characters, like 27AAPFU0939F1ZV." error={fieldError(state, "gstin")}>
          <Input id="gstin" name="gstin" defaultValue={defaults.gstin ?? ""} maxLength={15} autoCapitalize="characters" autoComplete="off" spellCheck={false} className="h-11 font-mono tracking-wider" />
        </Field>
        <Field label="PAN (optional)" htmlFor="pan" hint={defaults.panMasked ? `Saved: ${defaults.panMasked}. Enter again only to change it.` : "Must match your GSTIN. Stored encrypted."} error={fieldError(state, "pan")}>
          <Input id="pan" name="pan" maxLength={10} autoCapitalize="characters" autoComplete="off" spellCheck={false} className="h-11 font-mono tracking-wider" />
        </Field>
        <Field label="CIN (companies only)" htmlFor="cin" error={fieldError(state, "cin")}>
          <Input id="cin" name="cin" defaultValue={defaults.cin ?? ""} maxLength={21} autoCapitalize="characters" autoComplete="off" spellCheck={false} className="h-11 font-mono" />
        </Field>
      </div>
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-ink">Registered address</legend>
        <Field label="Address line 1" htmlFor="line1" error={fieldError(state, "registeredAddress")}>
          <Input id="line1" name="line1" required defaultValue={defaults.line1 ?? ""} autoComplete="address-line1" className="h-11" />
        </Field>
        <Field label="Address line 2 (optional)" htmlFor="line2">
          <Input id="line2" name="line2" defaultValue={defaults.line2 ?? ""} autoComplete="address-line2" className="h-11" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="City" htmlFor="city"><Input id="city" name="city" required defaultValue={defaults.city ?? ""} autoComplete="address-level2" className="h-11" /></Field>
          <Field label="State" htmlFor="stateCode">
            <Select id="stateCode" name="stateCode" required defaultValue={defaults.stateCode ?? ""} className="h-11">
              <option value="" disabled>Select state</option>
              {states.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Pincode" htmlFor="pincode"><Input id="pincode" name="pincode" required inputMode="numeric" maxLength={6} defaultValue={defaults.pincode ?? ""} autoComplete="postal-code" className="h-11" /></Field>
        </div>
      </fieldset>
      <Field label="Website (optional)" htmlFor="website" error={fieldError(state, "website")}>
        <Input id="website" name="website" type="url" defaultValue={defaults.website ?? ""} placeholder="https://" className="h-11" />
      </Field>
      <FormAlert state={state} />
      {state?.ok ? <CheckResults result={state.data} /> : null}
      <SubmitButton size="lg" pendingText="Checking…">{submitLabel}</SubmitButton>
    </form>
  );
}
