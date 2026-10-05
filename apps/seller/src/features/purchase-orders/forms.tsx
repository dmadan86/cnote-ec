"use client";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Alert, Field, Input, Select, Textarea } from "@cnote/ui";
import { submitFormAsAction } from "@cnote/next-kit/upload-client";
import { FormAlert, SubmitButton, fieldError } from "@/features/shell/form-bits";
import { acknowledgePoAction, msmeAction, voidInvoiceAction, type PoResult } from "./actions";

export function AckForm({ orderId, purchaseOrderId }: { orderId: string; purchaseOrderId: string }) {
  const t = useTranslations("purchaseOrders.ackForm");
  const [state, action] = useActionState<PoResult | null, FormData>(acknowledgePoAction, null);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="purchaseOrderId" value={purchaseOrderId} />
      <p className="text-sm text-muted">{t("hint")}</p>
      <FormAlert state={state} />
      <Field label={t("reason")} htmlFor="ack-reason" error={fieldError(state, "reason")}>
        <Textarea id="ack-reason" name="reason" maxLength={500} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <SubmitButton name="decision" value="accepted" pendingText={t("pending")}>{t("accept")}</SubmitButton>
        <SubmitButton name="decision" value="rejected" variant="outline" pendingText={t("pending")}>{t("reject")}</SubmitButton>
      </div>
    </form>
  );
}

export function VoidInvoiceForm({ orderId, invoiceId }: { orderId: string; invoiceId: string }) {
  const t = useTranslations("purchaseOrders.invoices");
  const [state, action] = useActionState<PoResult | null, FormData>(voidInvoiceAction, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <p className="text-xs text-muted">{t("voidHint")}</p>
      <FormAlert state={state} />
      <Field label={t("voidReason")} htmlFor={`void-${invoiceId}`} error={fieldError(state, "reason")}>
        <Input id={`void-${invoiceId}`} name="reason" required minLength={3} maxLength={300} className="h-11" />
      </Field>
      <SubmitButton variant="outline">{t("voidSubmit")}</SubmitButton>
    </form>
  );
}

/** Posts to /api/supplier-invoices (multipart, own body cap; server actions are capped at 2 MB). */
export function InvoiceForm({ orderId, purchaseOrderId, today }: { orderId: string; purchaseOrderId: string; today: string }) {
  const t = useTranslations("purchaseOrders.invoiceForm");
  const router = useRouter();
  const [state, action] = useActionState<PoResult | null, FormData>(async (_prev, fd) => {
    const r = await submitFormAsAction<null>("/api/supplier-invoices", fd);
    if (r.ok) router.refresh();
    return r;
  }, null);
  return (
    <form action={action} key={state?.ok ? "saved" : "draft"} className="space-y-4">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="purchaseOrderId" value={purchaseOrderId} />
      <p className="text-sm text-muted">{t("hint")}</p>
      <FormAlert state={state} />
      {state?.ok ? <Alert tone="success">{t("saved")}</Alert> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("number")} htmlFor="inv-number" hint={t("numberHint")} error={fieldError(state, "invoiceNumber")}>
          <Input id="inv-number" name="invoiceNumber" required maxLength={16} autoComplete="off" className="h-11" />
        </Field>
        <Field label={t("date")} htmlFor="inv-date" error={fieldError(state, "invoiceDate")}>
          <Input id="inv-date" name="invoiceDate" type="date" required max={today} defaultValue={today} className="h-11" />
        </Field>
        <Field label={t("taxable")} htmlFor="inv-taxable" error={fieldError(state, "taxable")}>
          <Input id="inv-taxable" name="taxable" type="number" inputMode="decimal" min={0} step={0.01} required className="h-11" />
        </Field>
        <Field label={t("gst")} htmlFor="inv-gst" error={fieldError(state, "gst")}>
          <Input id="inv-gst" name="gst" type="number" inputMode="decimal" min={0} step={0.01} required defaultValue={0} className="h-11" />
        </Field>
      </div>
      <Field label={t("file")} htmlFor="inv-file">
        <Input id="inv-file" name="file" type="file" accept="application/pdf,image/jpeg,image/png" className="h-auto py-2" />
      </Field>
      <details className="rounded-lg border border-line p-3">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-brand-700">{t("einvoiceTitle")}</summary>
        <p className="mb-3 text-sm text-muted">{t("einvoiceHint")}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("irn")} htmlFor="inv-irn" error={fieldError(state, "irn")} className="sm:col-span-2">
            <Input id="inv-irn" name="irn" maxLength={64} autoComplete="off" spellCheck={false} className="h-11 font-mono" />
          </Field>
          <Field label={t("ackNo")} htmlFor="inv-ack" error={fieldError(state, "ackNo")}>
            <Input id="inv-ack" name="ackNo" inputMode="numeric" autoComplete="off" className="h-11" />
          </Field>
          <Field label={t("ackDate")} htmlFor="inv-ackdate" error={fieldError(state, "ackDate")}>
            <Input id="inv-ackdate" name="ackDate" type="datetime-local" className="h-11" />
          </Field>
          <Field label={t("signedQr")} htmlFor="inv-qr" hint={t("signedQrHint")} error={fieldError(state, "signedQr")} className="sm:col-span-2">
            <Textarea id="inv-qr" name="signedQr" maxLength={2900} spellCheck={false} className="font-mono text-xs" />
          </Field>
          <Field label={t("ewbNo")} htmlFor="inv-ewb" error={fieldError(state, "ewbNo")}>
            <Input id="inv-ewb" name="ewbNo" inputMode="numeric" autoComplete="off" className="h-11" />
          </Field>
          <Field label={t("ewbValid")} htmlFor="inv-ewbvalid" error={fieldError(state, "ewbValidUntil")}>
            <Input id="inv-ewbvalid" name="ewbValidUntil" type="datetime-local" className="h-11" />
          </Field>
        </div>
      </details>
      <SubmitButton pendingText={t("pending")}>{t("submit")}</SubmitButton>
    </form>
  );
}

const CATEGORIES = ["micro", "small", "medium"] as const;

export function MsmeForm({ category, udyamOnFile, covered }: { category: (typeof CATEGORIES)[number] | null; udyamOnFile: boolean; covered: boolean }) {
  const t = useTranslations("purchaseOrders.msme");
  const [state, action] = useActionState<PoResult | null, FormData>(msmeAction, null);
  return (
    <form action={action} className="space-y-4">
      <p className="text-sm text-muted">{t("intro")}</p>
      <FormAlert state={state} />
      {state?.ok ? <Alert tone="success">{t("saved")}</Alert> : null}
      <Field label={t("category")} htmlFor="msme-category">
        <Select id="msme-category" name="category" defaultValue={category ?? ""} className="h-11">
          <option value="">{t("none")}</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{t(c)}</option>)}
        </Select>
      </Field>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="confirm" value="yes" className="mt-1 size-5 shrink-0" />
        <span>{t("declaration")}</span>
      </label>
      <p className="text-sm text-muted">{udyamOnFile ? t("udyamOn") : t("udyamOff")} {covered ? t("covered") : t("notCovered")}</p>
      <SubmitButton pendingText={t("pending")}>{t("save")}</SubmitButton>
    </form>
  );
}
