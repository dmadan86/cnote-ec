"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Field, Input, Select, Textarea } from "@cnote/ui";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useActionState } from "react";
import { amendPoAction, cancelPoAction, issuePoAction, payInvoiceAction } from "./actions";

type State = ActionResult | null;
const GST_PERCENTS = [0, 3, 5, 12, 18, 28, 40];

function Result({ state, ok }: { state: State; ok?: string }) {
  if (!state) return null;
  return state.ok ? (ok ? <Alert tone="success">{ok}</Alert> : null) : <Alert tone="danger">{state.error}</Alert>;
}

export interface AddressOption { id: string; label: string; summary: string; isDefault: boolean }

/** Issue (no PO yet) or amend (new version) a purchase order. Lines come from the order; only terms are edited here. */
export function PoForm(props: {
  mode: "issue" | "amend";
  orderId: string;
  purchaseOrderId?: string;
  addresses: AddressOption[];
  defaults: { addressId: string | null; paymentTermsDays: number | null; expectedDelivery: string | null; notes: string | null; gstPercent: number };
  today: string;
  /** amend: the address already on the PO, kept unless another is chosen */
  currentAddress?: string;
}) {
  const t = useTranslations("po");
  const issue = props.mode === "issue";
  const [state, action, pending] = useActionState<State, FormData>(issue ? issuePoAction : amendPoAction, null);
  const err = (k: string) => (state && !state.ok && state.fieldErrors?.[k]) || undefined;
  if (props.addresses.length === 0) {
    return (
      <Alert tone="warning">
        {t("form.addressNone")}{" "}
        <Link href="/account/business" className="font-medium underline">{t("form.addressAdd")}</Link>
      </Alert>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="orderId" value={props.orderId} />
      {props.purchaseOrderId ? <input type="hidden" name="purchaseOrderId" value={props.purchaseOrderId} /> : null}
      <Result state={state} ok={t("form.saved")} />
      <Field label={t("form.address")} htmlFor={`${props.mode}-address`} error={err("addressId")}>
        <Select id={`${props.mode}-address`} name="addressId" defaultValue={issue ? (props.defaults.addressId ?? props.addresses.find((a) => a.isDefault)?.id ?? props.addresses[0]!.id) : ""} required={issue}>
          {!issue ? <option value="">{t("deliverTo")}: {props.currentAddress}</option> : null}
          {props.addresses.map((a) => <option key={a.id} value={a.id}>{a.label}: {a.summary}</option>)}
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("form.terms")} htmlFor={`${props.mode}-terms`} hint={t("form.termsHint")} error={err("paymentTermsDays")}>
          <Input id={`${props.mode}-terms`} name="paymentTermsDays" type="number" inputMode="numeric" min={0} max={180} step={1} required defaultValue={props.defaults.paymentTermsDays ?? undefined} />
        </Field>
        <Field label={t("form.delivery")} htmlFor={`${props.mode}-delivery`} error={err("expectedDelivery")}>
          <Input id={`${props.mode}-delivery`} name="expectedDelivery" type="date" min={props.today} defaultValue={props.defaults.expectedDelivery ?? undefined} />
        </Field>
        {issue ? (
          <>
            <Field label={t("form.gstRate")} htmlFor="issue-gst">
              <Select id="issue-gst" name="gstPercent" defaultValue={String(props.defaults.gstPercent)}>
                {GST_PERCENTS.map((p) => <option key={p} value={p}>{p}%</option>)}
              </Select>
            </Field>
            <Field label={t("form.hsn")} htmlFor="issue-hsn" error={err("lines")}>
              <Input id="issue-hsn" name="hsn" inputMode="numeric" pattern="[0-9]{2,8}" maxLength={8} autoComplete="off" />
            </Field>
          </>
        ) : null}
      </div>
      <Field label={t("form.notes")} htmlFor={`${props.mode}-notes`} error={err("notes")}>
        <Textarea id={`${props.mode}-notes`} name="notes" maxLength={1000} defaultValue={props.defaults.notes ?? undefined} />
      </Field>
      <div>
        <Button type="submit" disabled={pending}>{pending ? t(issue ? "form.issuing" : "form.pending") : t(issue ? "form.issue" : "form.amend")}</Button>
      </div>
    </form>
  );
}

export function CancelPoForm({ orderId, purchaseOrderId }: { orderId: string; purchaseOrderId: string }) {
  const t = useTranslations("po");
  const [state, action, pending] = useActionState<State, FormData>(cancelPoAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="purchaseOrderId" value={purchaseOrderId} />
      <Result state={state} />
      <Field label={t("form.cancelReason")} htmlFor="cancel-reason" error={state && !state.ok ? state.fieldErrors?.reason : undefined}>
        <Input id="cancel-reason" name="reason" required minLength={3} maxLength={300} />
      </Field>
      <div>
        <Button type="submit" variant="outline" disabled={pending}>{t("form.cancel")}</Button>
      </div>
    </form>
  );
}

/** Mark an invoice paid (full or part): date, UTR / bank reference. Records the buyer's own payment; nothing is paid from here. */
export function PayForm({ invoiceId, orderId, balanceLabel, today, minDate }: { invoiceId: string; orderId: string; balanceLabel: string; today: string; minDate: string }) {
  const t = useTranslations("po");
  const [state, action, pending] = useActionState<State, FormData>(payInvoiceAction, null);
  const id = `pay-${invoiceId}`;
  const err = (k: string) => (state && !state.ok && state.fieldErrors?.[k]) || undefined;
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="orderId" value={orderId} />
      <p className="text-xs text-muted">{t("pay.note")}</p>
      <Result state={state} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t("pay.amount")} htmlFor={`${id}-amount`} hint={t("pay.amountHint", { balance: balanceLabel })} error={err("amount")}>
          <Input id={`${id}-amount`} name="amount" type="number" inputMode="decimal" min={0.01} step={0.01} />
        </Field>
        <Field label={t("pay.date")} htmlFor={`${id}-date`} error={err("paidOn")}>
          <Input id={`${id}-date`} name="paidOn" type="date" required min={minDate} max={today} defaultValue={today} />
        </Field>
        <Field label={t("pay.reference")} htmlFor={`${id}-ref`} hint={t("pay.referenceHint")} error={err("reference")}>
          <Input id={`${id}-ref`} name="reference" required minLength={6} maxLength={30} autoComplete="off" autoCapitalize="characters" />
        </Field>
      </div>
      <div>
        <Button type="submit" disabled={pending}>{pending ? t("pay.pending") : t("pay.submit")}</Button>
      </div>
    </form>
  );
}
