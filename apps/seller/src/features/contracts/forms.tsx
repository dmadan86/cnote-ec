"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import type { RcItemView, RcRevisionView } from "@cnote/enquiry";
import { Alert, Field, Input, Select, Textarea } from "@cnote/ui";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import { proposeContractAction, respondContractAction, terminateContractAction, type ContractResult } from "./actions";

export function RespondForm({ contractId, revision }: { contractId: string; revision: number }) {
  const t = useTranslations("contracts.respond");
  const [state, action] = useActionState<ContractResult | null, FormData>(respondContractAction, null);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="contractId" value={contractId} />
      <input type="hidden" name="revision" value={revision} />
      <p className="text-sm text-muted">{t("hint")}</p>
      <FormAlert state={state} />
      <Field label={t("reason")} htmlFor="resp-reason" hint={t("reasonHint")} error={fieldError(state, "reason")}>
        <Textarea id="resp-reason" name="reason" maxLength={500} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <SubmitButton name="decision" value="accepted" pendingText={t("pending")}>{t("accept")}</SubmitButton>
        <SubmitButton name="decision" value="rejected" variant="outline" pendingText={t("pending")}>{t("decline")}</SubmitButton>
      </div>
    </form>
  );
}

export function TerminateForm({ contractId }: { contractId: string }) {
  const t = useTranslations("contracts.terminate");
  const [state, action] = useActionState<ContractResult | null, FormData>(terminateContractAction, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="contractId" value={contractId} />
      <p className="text-xs text-muted">{t("hint")}</p>
      <FormAlert state={state} />
      <Field label={t("reason")} htmlFor="term-reason" error={fieldError(state, "reason")}>
        <Input id="term-reason" name="reason" required minLength={3} maxLength={300} className="h-11" />
      </Field>
      <SubmitButton variant="outline" pendingText={t("pending")}>{t("submit")}</SubmitButton>
    </form>
  );
}

const rupees = (paise: number) => String(paise / 100);

/** Counter-proposal / amendment: prefilled from the revision being looked at. Sent as a NEW revision the buyer must accept. */
export function ProposeForm({ contractId, base, today }: { contractId: string; base: RcRevisionView; today: string }) {
  const t = useTranslations("contracts.propose");
  const [state, action] = useActionState<ContractResult | null, FormData>(proposeContractAction, null);
  const items: (RcItemView | null)[] = [...base.items, null]; // one blank row to add an item
  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="contractId" value={contractId} />
      <input type="hidden" name="itemCount" value={items.length} />
      <p className="text-sm text-muted">{t("hint")}</p>
      <FormAlert state={state} />
      {state?.ok ? <Alert tone="success">{t("saved")}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("validFrom")} htmlFor="pr-from" error={fieldError(state, "validFrom")}>
          <Input id="pr-from" name="validFrom" type="date" required defaultValue={base.validFrom} className="h-11" />
        </Field>
        <Field label={t("validTo")} htmlFor="pr-to" error={fieldError(state, "validTo")}>
          <Input id="pr-to" name="validTo" type="date" required min={today} defaultValue={base.validTo} className="h-11" />
        </Field>
        <Field label={t("paymentTerms")} htmlFor="pr-terms" error={fieldError(state, "paymentTermsDays")}>
          <Input id="pr-terms" name="paymentTermsDays" type="number" min={0} max={180} required defaultValue={base.paymentTermsDays} className="h-11" />
        </Field>
        <Field label={t("priceBasis")} htmlFor="pr-basis" error={fieldError(state, "priceBasis")}>
          <Select id="pr-basis" name="priceBasis" defaultValue={base.priceBasis} className="h-11">
            {(["ex_works", "for_destination", "delivered", "other"] as const).map((b) => <option key={b} value={b}>{t(`basis.${b}`)}</option>)}
          </Select>
        </Field>
        <Field label={t("valueCap")} htmlFor="pr-cap" hint={t("valueCapHint")} error={fieldError(state, "valueCapPaise")}>
          <Input id="pr-cap" name="valueCap" type="number" min={1} step="0.01" defaultValue={base.valueCapPaise === null ? "" : rupees(base.valueCapPaise)} className="h-11" />
        </Field>
      </div>
      {fieldError(state, "items") ? <Alert tone="danger">{fieldError(state, "items")}</Alert> : null}
      {items.map((it, i) => (
        <fieldset key={it?.itemKey ?? `new-${i}`} className="space-y-3 rounded-lg border border-line p-3">
          <legend className="px-1 text-sm font-semibold text-ink">{it ? t("itemN", { n: i + 1 }) : t("newItem")}</legend>
          <input type="hidden" name={`item_${i}_key`} value={it?.itemKey ?? ""} />
          <input type="hidden" name={`item_${i}_listing`} value={it?.listingId ?? ""} />
          <input type="hidden" name={`item_${i}_hsn`} value={it?.hsn ?? ""} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t("item.description")} htmlFor={`i${i}-d`} className="sm:col-span-3">
              <Input id={`i${i}-d`} name={`item_${i}_description`} maxLength={300} defaultValue={it?.description ?? ""} className="h-11" />
            </Field>
            <Field label={t("item.unit")} htmlFor={`i${i}-u`}>
              <Input id={`i${i}-u`} name={`item_${i}_unit`} maxLength={32} defaultValue={it?.unit ?? ""} className="h-11" />
            </Field>
            <Field label={t("item.price")} htmlFor={`i${i}-p`}>
              <Input id={`i${i}-p`} name={`item_${i}_price`} type="number" min={0.01} step="0.01" defaultValue={it ? rupees(it.unitPricePaise) : ""} className="h-11" />
            </Field>
            <Field label={t("item.gst")} htmlFor={`i${i}-g`}>
              <Input id={`i${i}-g`} name={`item_${i}_gst`} type="number" min={0} max={40} step="0.01" defaultValue={it ? String(it.gstRateBps / 100) : "18"} className="h-11" />
            </Field>
            <Field label={t("item.moq")} htmlFor={`i${i}-m`}>
              <Input id={`i${i}-m`} name={`item_${i}_moq`} type="number" min={1} defaultValue={it?.moq ?? ""} className="h-11" />
            </Field>
            <Field label={t("item.cap")} htmlFor={`i${i}-c`}>
              <Input id={`i${i}-c`} name={`item_${i}_cap`} type="number" min={1} defaultValue={it?.quantityCap ?? ""} className="h-11" />
            </Field>
            <Field label={t("item.variation")} htmlFor={`i${i}-v`}>
              <Select id={`i${i}-v`} name={`item_${i}_variation`} defaultValue={it?.variationKind ?? "fixed"} className="h-11">
                <option value="fixed">{t("item.fixed")}</option>
                <option value="indexed">{t("item.indexed")}</option>
              </Select>
            </Field>
            <Field label={t("item.varCap")} htmlFor={`i${i}-vc`} hint={t("item.varHint")}>
              <Input id={`i${i}-vc`} name={`item_${i}_varcap`} type="number" min={0.01} max={50} step="0.01" defaultValue={it?.variationCapBps ? String(it.variationCapBps / 100) : ""} className="h-11" />
            </Field>
            <Field label={t("item.varNote")} htmlFor={`i${i}-vn`}>
              <Input id={`i${i}-vn`} name={`item_${i}_varnote`} maxLength={300} defaultValue={it?.variationNote ?? ""} className="h-11" />
            </Field>
          </div>
          {it ? (
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" name={`item_${i}_remove`} value="yes" className="size-5" /> {t("item.remove")}
            </label>
          ) : null}
        </fieldset>
      ))}
      <Field label={t("notes")} htmlFor="pr-notes" error={fieldError(state, "notes")}>
        <Textarea id="pr-notes" name="notes" maxLength={2000} defaultValue={base.notes ?? ""} />
      </Field>
      <Field label={t("changeNote")} htmlFor="pr-change" hint={t("changeNoteHint")} error={fieldError(state, "changeNote")}>
        <Textarea id="pr-change" name="changeNote" maxLength={500} />
      </Field>
      <SubmitButton pendingText={t("pending")}>{t("submit")}</SubmitButton>
    </form>
  );
}
