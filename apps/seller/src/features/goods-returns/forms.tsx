"use client";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Alert, Field, Input, Select, Textarea } from "@cnote/ui";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import { creditNoteAction, decideReturnAction, receiveReturnAction, type ReturnResult } from "./actions";

export function DecideForm({ returnId }: { returnId: string }) {
  const t = useTranslations("goodsReturns.decide");
  const [state, action] = useActionState<ReturnResult | null, FormData>(decideReturnAction, null);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="returnId" value={returnId} />
      <p className="text-sm text-muted">{t("hint")}</p>
      <FormAlert state={state} />
      <Field label={t("note")} htmlFor="decide-note" hint={t("noteHint")} error={fieldError(state, "note")}>
        <Textarea id="decide-note" name="note" maxLength={500} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <SubmitButton name="decision" value="approved" pendingText={t("pending")}>{t("approve")}</SubmitButton>
        <SubmitButton name="decision" value="rejected" variant="outline" pendingText={t("pending")}>{t("reject")}</SubmitButton>
      </div>
    </form>
  );
}

export function ReceiveForm({ returnId }: { returnId: string }) {
  const t = useTranslations("goodsReturns.receive");
  const [state, action] = useActionState<ReturnResult | null, FormData>(receiveReturnAction, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="returnId" value={returnId} />
      <FormAlert state={state} />
      <SubmitButton variant="outline" pendingText={t("pending")}>{t("submit")}</SubmitButton>
    </form>
  );
}

export interface CreditableInvoice { id: string; invoiceNumber: string; creditable: string }

export function CreditNoteForm({ returnId, invoices, today, estimate }: { returnId: string; invoices: CreditableInvoice[]; today: string; estimate: string }) {
  const t = useTranslations("goodsReturns.credit");
  const [state, action] = useActionState<ReturnResult | null, FormData>(creditNoteAction, null);
  if (invoices.length === 0) return <Alert tone="warning">{t("noInvoice")}</Alert>;
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="returnId" value={returnId} />
      <p className="text-sm text-muted">{t("hint", { estimate })}</p>
      <FormAlert state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("invoice")} htmlFor="cn-invoice" error={fieldError(state, "invoiceId")}>
          <Select id="cn-invoice" name="invoiceId" required defaultValue={invoices[0]!.id} className="h-11">
            {invoices.map((i) => <option key={i.id} value={i.id}>{t("invoiceOption", { number: i.invoiceNumber, amount: i.creditable })}</option>)}
          </Select>
        </Field>
        <Field label={t("number")} htmlFor="cn-number" hint={t("numberHint")} error={fieldError(state, "number")}>
          <Input id="cn-number" name="number" required maxLength={16} autoComplete="off" className="h-11" />
        </Field>
        <Field label={t("date")} htmlFor="cn-date" error={fieldError(state, "noteDate")}>
          <Input id="cn-date" name="noteDate" type="date" required max={today} defaultValue={today} className="h-11" />
        </Field>
        <Field label={t("irn")} htmlFor="cn-irn" hint={t("irnHint")} error={fieldError(state, "irn")}>
          <Input id="cn-irn" name="irn" maxLength={64} autoComplete="off" spellCheck={false} className="h-11 font-mono" />
        </Field>
        <Field label={t("taxable")} htmlFor="cn-taxable" error={fieldError(state, "taxable")}>
          <Input id="cn-taxable" name="taxable" type="number" inputMode="decimal" min={0} step={0.01} required className="h-11" />
        </Field>
        <Field label={t("gst")} htmlFor="cn-gst" error={fieldError(state, "gst")}>
          <Input id="cn-gst" name="gst" type="number" inputMode="decimal" min={0} step={0.01} required defaultValue={0} className="h-11" />
        </Field>
      </div>
      <SubmitButton pendingText={t("pending")}>{t("submit")}</SubmitButton>
    </form>
  );
}
