"use client";
import { Alert, Button, Field, Input, Select, Textarea } from "@cnote/ui";
import { useEffect, useRef, useState } from "react";
import { createMandateAction, updateMandateAction } from "./actions";
import { ActionMessage, text } from "./action-message";
import { fmt, type A2aLabels } from "./labels";
import { useA2aAction } from "./use-a2a-action";

export interface MandateDefaults {
  id?: string; name: string; title: string; requirement: string; categorySlug: string; quantity: string; unit: string; target: string; max: string; lead: string;
  sellers: string; recurDays: number | null; expiry: string;
}
export const EMPTY_DEFAULTS: MandateDefaults = { name: "", title: "", requirement: "", categorySlug: "", quantity: "", unit: "", target: "", max: "", lead: "", sellers: "", recurDays: null, expiry: "" };

const inputCls = "min-h-11";
const checkCls = "mt-0.5 h-6 w-6 shrink-0 accent-brand-600";

/** Create (mode="create") or edit (mode="edit") a buying mandate. Auto-accept is off by default; turning it on needs its own consent + a ceiling <= max. */
export function MandateForm({ mode, t, defaults = EMPTY_DEFAULTS }: { mode: "create" | "edit"; t: A2aLabels; defaults?: MandateDefaults }) {
  const { state, pending, onSubmit } = useA2aAction(mode === "create" ? createMandateAction : updateMandateAction);
  const [recur, setRecur] = useState<"once" | "every">(defaults.recurDays ? "every" : "once");
  const [auto, setAuto] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const errors: Record<string, string> = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const n = Object.keys(errors).length;
  useEffect(() => {
    if (n > 0) summaryRef.current?.focus(); // move focus to the error summary so keyboard/screen-reader users land on it (WCAG 3.3.1)
  }, [state, n]);
  const e = (k: string) => (errors[k] ? text(t, errors[k]) : undefined);
  const p = mode === "create" ? "mc" : "me";

  return (
    <form onSubmit={onSubmit} noValidate aria-labelledby={`${p}-h`} className="flex flex-col gap-4">
      <div>
        <h2 id={`${p}-h`} className="text-lg font-bold text-ink">{mode === "create" ? t.createHeading : t.editHeading}</h2>
        {mode === "create" ? <p className="mt-1 text-sm text-muted">{t.createHint}</p> : null}
      </div>
      {defaults.id ? <input type="hidden" name="id" value={defaults.id} /> : null}
      <div ref={summaryRef} tabIndex={-1} className="outline-none focus-visible:outline-2 focus-visible:outline-brand-600">
        {n > 0 ? <Alert tone="danger">{fmt(t.errSummary, { n })}</Alert> : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.fName} htmlFor={`${p}-name`} error={e("name")}>
          <Input id={`${p}-name`} name="name" required minLength={3} maxLength={80} defaultValue={defaults.name} className={inputCls} />
        </Field>
        <Field label={t.fTitle} htmlFor={`${p}-title`} error={e("title")}>
          <Input id={`${p}-title`} name="title" required minLength={5} maxLength={140} defaultValue={defaults.title} className={inputCls} />
        </Field>
      </div>
      <Field label={t.fRequirement} htmlFor={`${p}-req`} error={e("requirement")}>
        <Textarea id={`${p}-req`} name="requirement" required minLength={10} maxLength={4000} defaultValue={defaults.requirement} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t.fCategory} htmlFor={`${p}-cat`}>
          <Input id={`${p}-cat`} name="categorySlug" maxLength={100} defaultValue={defaults.categorySlug} className={inputCls} />
        </Field>
        <Field label={t.fQuantity} htmlFor={`${p}-qty`} error={e("quantity")}>
          <Input id={`${p}-qty`} name="quantity" inputMode="numeric" autoComplete="off" required defaultValue={defaults.quantity} className={inputCls} />
        </Field>
        <Field label={t.fUnit} htmlFor={`${p}-unit`} error={e("unit")}>
          <Input id={`${p}-unit`} name="unit" required maxLength={20} defaultValue={defaults.unit} className={inputCls} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t.fTarget} htmlFor={`${p}-target`} hint={t.fTargetHint} error={e("target")}>
          <Input id={`${p}-target`} name="target" inputMode="decimal" autoComplete="off" defaultValue={defaults.target} className={inputCls} />
        </Field>
        <Field label={t.fMax} htmlFor={`${p}-max`} hint={t.fMaxHint} error={e("max")}>
          <Input id={`${p}-max`} name="max" inputMode="decimal" autoComplete="off" required defaultValue={defaults.max} className={inputCls} />
        </Field>
        <Field label={t.fLead} htmlFor={`${p}-lead`} error={e("lead")}>
          <Input id={`${p}-lead`} name="lead" inputMode="numeric" autoComplete="off" defaultValue={defaults.lead} className={inputCls} />
        </Field>
      </div>
      <Field label={t.fSellers} htmlFor={`${p}-sellers`} hint={t.fSellersHint} error={e("sellers")}>
        <Textarea id={`${p}-sellers`} name="sellers" spellCheck={false} autoComplete="off" defaultValue={defaults.sellers} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t.fRecur} htmlFor={`${p}-recur`}>
          <Select id={`${p}-recur`} name="recurMode" value={recur} onChange={(ev) => setRecur(ev.target.value === "every" ? "every" : "once")} className={inputCls}>
            <option value="once">{t.recurOnce}</option>
            <option value="every">{t.recurEvery}</option>
          </Select>
        </Field>
        <Field label={t.fRecurDays} htmlFor={`${p}-days`} error={e("recurDays")}>
          <Input id={`${p}-days`} name="recurDays" inputMode="numeric" autoComplete="off" disabled={recur === "once"} required={recur === "every"} defaultValue={defaults.recurDays ?? ""} className={inputCls} />
        </Field>
        <Field label={t.fExpiry} htmlFor={`${p}-exp`} error={e("expiry")}>
          <Input id={`${p}-exp`} name="expiry" type="date" defaultValue={defaults.expiry} className={inputCls} />
        </Field>
      </div>

      {mode === "create" ? (
        <>
          <fieldset className="flex flex-col gap-3 rounded-lg border border-line p-4">
            <legend className="px-1 text-sm font-semibold text-ink">{t.autoHeading}</legend>
            <p className="text-sm text-muted">{t.autoDefault}</p>
            <label className="flex min-h-11 items-start gap-3 text-sm text-ink">
              <input type="checkbox" name="autoAccept" checked={auto} onChange={(ev) => setAuto(ev.target.checked)} aria-controls="mc-auto-fields" aria-expanded={auto} className={checkCls} />
              <span>{t.fAuto}</span>
            </label>
            <div id="mc-auto-fields" hidden={!auto} className="flex flex-col gap-3">
              {auto ? (
                <>
                  <Field label={t.fAutoLimit} htmlFor="mc-autolimit" hint={t.fAutoLimitHint} error={e("autoLimit")}>
                    <Input id="mc-autolimit" name="autoLimit" inputMode="decimal" autoComplete="off" required className={inputCls} />
                  </Field>
                  <div>
                    <label className="flex min-h-11 items-start gap-3 text-sm text-ink">
                      <input type="checkbox" name="autoConsent" required aria-describedby={e("autoConsent") ? "mc-autoconsent-err" : undefined} aria-invalid={e("autoConsent") ? true : undefined} className={checkCls} />
                      <span>{t.fAutoConsent}</span>
                    </label>
                    {e("autoConsent") ? <p id="mc-autoconsent-err" role="alert" className="ml-9 text-xs text-danger">{e("autoConsent")}</p> : null}
                  </div>
                </>
              ) : null}
            </div>
          </fieldset>
          <div>
            <label className="flex min-h-11 items-start gap-3 text-sm font-medium text-ink">
              <input type="checkbox" name="optIn" required aria-describedby={e("optIn") ? "mc-optin-err" : undefined} aria-invalid={e("optIn") ? true : undefined} className={checkCls} />
              <span>{t.fOptIn}</span>
            </label>
            {e("optIn") ? <p id="mc-optin-err" role="alert" className="ml-9 text-xs text-danger">{e("optIn")}</p> : null}
          </div>
        </>
      ) : null}

      <p className="text-sm font-medium text-ink">{t.commitNote}</p>
      <ActionMessage state={state && (state.ok || !state.fieldErrors) ? state : null} t={t} />
      <div>
        <Button type="submit" variant="primary" disabled={pending} aria-busy={pending} className="min-h-11">
          {mode === "create" ? (pending ? t.creating : t.create) : pending ? t.saving : t.save}
        </Button>
      </div>
    </form>
  );
}
