"use client";
import type { ActionResult } from "@cnote/next-kit";
import { submitFormAsAction } from "@cnote/next-kit/upload-client";
import { Alert, Button, Field, Input, Select, Textarea } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import { cancelReturnAction, matchSettingsAction, requestReturnAction, returnDisputeAction, shipReturnAction } from "./actions";

type State = ActionResult | null;
const REJECT_REASONS = ["damaged", "short", "wrong_spec", "quality_fail"] as const;
const RETURN_REASONS = [...REJECT_REASONS, "not_as_ordered", "other"] as const;

function Result({ state, ok }: { state: { ok: boolean; error?: string } | null; ok?: string }) {
  if (!state) return null;
  return state.ok ? (ok ? <Alert tone="success">{ok}</Alert> : null) : <Alert tone="danger">{state.error}</Alert>;
}
const fieldErr = (state: ActionResult<unknown> | null, k: string): string | undefined => (state && !state.ok && state.fieldErrors?.[k]) || undefined;

export interface ReceiptFormLine { lineNo: number; description: string; unit: string; orderedQty: number; receivedQty: number; maxReceivable: number }

/** Record a goods receipt: per PO line the quantity received and rejected (accepted is worked out), a reason, photos, date and receiver. */
export function ReceiptForm({ orderId, purchaseOrderId, today, minDate, lines }: { orderId: string; purchaseOrderId: string; today: string; minDate: string; lines: ReceiptFormLine[] }) {
  const t = useTranslations("grn.form");
  const tr = useTranslations("grn.reasons");
  const router = useRouter();
  const [qty, setQty] = useState<Record<number, { received: string; rejected: string }>>({});
  const [state, action, pending] = useActionState<ActionResult<{ id: string; number: string }> | null, FormData>(async (_prev, fd) => {
    const r = await submitFormAsAction<{ id: string; number: string }>("/api/goods-receipts", fd, { refreshUrl: "/api/me" });
    if (r.ok) { setQty({}); router.refresh(); }
    return r;
  }, null);
  const err = (k: string) => fieldErr(state, k);
  return (
    <form action={action} key={state?.ok ? `saved-${state.data.id}` : "draft"} className="flex flex-col gap-5">
      <input type="hidden" name="orderId" value={orderId} />
      <input type="hidden" name="purchaseOrderId" value={purchaseOrderId} />
      {state?.ok ? <Alert tone="success">{t("saved", { number: state.data.number })}</Alert> : <Result state={state} />}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t("receivedOn")} htmlFor="grn-date" error={err("receivedOn")}>
          <Input id="grn-date" name="receivedOn" type="date" required min={minDate} max={today} defaultValue={today} />
        </Field>
        <Field label={t("receiver")} htmlFor="grn-receiver" hint={t("receiverHint")} error={err("receiverName")}>
          <Input id="grn-receiver" name="receiverName" required minLength={2} maxLength={80} autoComplete="name" />
        </Field>
        <Field label={t("challan")} htmlFor="grn-challan" hint={t("challanHint")} error={err("deliveryNoteRef")}>
          <Input id="grn-challan" name="deliveryNoteRef" maxLength={40} autoComplete="off" />
        </Field>
      </div>
      {err("lines") ? <Alert tone="danger">{err("lines")}</Alert> : null}
      {lines.map((l) => {
        const q = qty[l.lineNo] ?? { received: "", rejected: "" };
        const received = Number(q.received) || 0;
        const rejected = Number(q.rejected) || 0;
        const accepted = received - rejected;
        const id = `grn-l${l.lineNo}`;
        return (
          <fieldset key={l.lineNo} className="rounded-lg border border-line p-4">
            <legend className="px-1 text-sm font-semibold text-ink">{l.description}</legend>
            <p className="mb-3 text-xs text-muted">{t("lineSummary", { ordered: l.orderedQty, received: l.receivedQty, unit: l.unit, max: l.maxReceivable })}</p>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t("qtyReceived", { unit: l.unit })} htmlFor={`${id}-rec`}>
                <Input id={`${id}-rec`} name={`received__${l.lineNo}`} type="number" inputMode="numeric" min={0} max={l.maxReceivable} step={1} value={q.received} onChange={(e) => setQty({ ...qty, [l.lineNo]: { ...q, received: e.target.value } })} />
              </Field>
              <Field label={t("qtyRejected", { unit: l.unit })} htmlFor={`${id}-rej`}>
                <Input id={`${id}-rej`} name={`rejected__${l.lineNo}`} type="number" inputMode="numeric" min={0} max={received || undefined} step={1} value={q.rejected} onChange={(e) => setQty({ ...qty, [l.lineNo]: { ...q, rejected: e.target.value } })} />
              </Field>
              <div className="flex flex-col justify-end pb-2 text-sm">
                <span className="text-xs text-muted">{t("qtyAccepted")}</span>
                <output htmlFor={`${id}-rec ${id}-rej`} aria-live="polite" className={`text-lg font-semibold ${accepted < 0 ? "text-danger" : "text-ink"}`}>{accepted < 0 ? t("invalid") : accepted}</output>
              </div>
            </div>
            {rejected > 0 ? (
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field label={t("reason")} htmlFor={`${id}-reason`} error={err("rejectReason")}>
                  <Select id={`${id}-reason`} name={`reason__${l.lineNo}`} required defaultValue="">
                    <option value="" disabled>{t("reasonChoose")}</option>
                    {REJECT_REASONS.map((r) => <option key={r} value={r}>{tr(r)}</option>)}
                  </Select>
                </Field>
                <Field label={t("rejectNote")} htmlFor={`${id}-note`} error={err("rejectNote")}>
                  <Input id={`${id}-note`} name={`note__${l.lineNo}`} maxLength={300} />
                </Field>
              </div>
            ) : null}
          </fieldset>
        );
      })}
      <Field label={t("photos")} htmlFor="grn-photos" hint={t("photosHint")} error={err("photos")}>
        <Input id="grn-photos" name="photos" type="file" multiple accept="image/jpeg,image/png" className="h-auto py-2" />
      </Field>
      <Field label={t("note")} htmlFor="grn-note" error={err("note")}>
        <Textarea id="grn-note" name="note" maxLength={500} />
      </Field>
      <p className="text-xs text-muted">{t("deliveryNote")}</p>
      <div><Button type="submit" disabled={pending}>{pending ? t("pending") : t("submit")}</Button></div>
    </form>
  );
}

/** Three-way match tolerances for this buyer business. */
export function MatchSettingsForm({ orderId, qtyPercent, pricePercent, blockPendingGrn }: { orderId: string; qtyPercent: number; pricePercent: number; blockPendingGrn: boolean }) {
  const t = useTranslations("grn.settings");
  const [state, action, pending] = useActionState<State, FormData>(matchSettingsAction, null);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="orderId" value={orderId} />
      <Result state={state} ok={t("saved")} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("qty")} htmlFor="tol-qty" hint={t("qtyHint")} error={fieldErr(state, "qtyTolerance")}>
          <Input id="tol-qty" name="qtyTolerance" type="number" inputMode="decimal" min={0} max={20} step={0.01} required defaultValue={qtyPercent} />
        </Field>
        <Field label={t("price")} htmlFor="tol-price" hint={t("priceHint")} error={fieldErr(state, "priceTolerance")}>
          <Input id="tol-price" name="priceTolerance" type="number" inputMode="decimal" min={0} max={20} step={0.01} required defaultValue={pricePercent} />
        </Field>
      </div>
      <label className="flex min-h-11 items-start gap-3 text-sm">
        <input type="checkbox" name="blockPendingGrn" defaultChecked={blockPendingGrn} className="mt-1 h-5 w-5" />
        <span>{t("blockPending")}</span>
      </label>
      <div><Button type="submit" variant="outline" disabled={pending}>{pending ? t("pending") : t("save")}</Button></div>
    </form>
  );
}

export interface ReturnFormLine { receiptLineId: string; description: string; unit: string; rejectedReturnable: number; acceptedReturnable: number }

/** Request a return from a receipt: units from the rejected stock and/or the accepted stock, and a reason. */
export function ReturnRequestForm({ receiptId, lines }: { receiptId: string; lines: ReturnFormLine[] }) {
  const t = useTranslations("grn.returnForm");
  const tr = useTranslations("grn.returnReasons");
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionResult<{ id: string }> | null, FormData>(async (prev, fd) => {
    const r = await requestReturnAction(prev, fd);
    if (r.ok) router.push(`/buyer/returns/${r.data.id}`);
    return r;
  }, null);
  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="receiptId" value={receiptId} />
      <Result state={state} />
      {fieldErr(state, "lines") ? <Alert tone="danger">{fieldErr(state, "lines")}</Alert> : null}
      {lines.map((l) => (
        <fieldset key={l.receiptLineId} className="rounded-lg border border-line p-4">
          <legend className="px-1 text-sm font-semibold text-ink">{l.description}</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("fromRejected", { max: l.rejectedReturnable, unit: l.unit })} htmlFor={`rr-${l.receiptLineId}`}>
              <Input id={`rr-${l.receiptLineId}`} name={`qty__${l.receiptLineId}__rejected`} type="number" inputMode="numeric" min={0} max={l.rejectedReturnable} step={1} disabled={l.rejectedReturnable === 0} />
            </Field>
            <Field label={t("fromAccepted", { max: l.acceptedReturnable, unit: l.unit })} htmlFor={`ra-${l.receiptLineId}`}>
              <Input id={`ra-${l.receiptLineId}`} name={`qty__${l.receiptLineId}__accepted`} type="number" inputMode="numeric" min={0} max={l.acceptedReturnable} step={1} disabled={l.acceptedReturnable === 0} />
            </Field>
          </div>
        </fieldset>
      ))}
      <Field label={t("reason")} htmlFor="ret-reason" error={fieldErr(state, "reasonCode")}>
        <Select id="ret-reason" name="reasonCode" required defaultValue="">
          <option value="" disabled>{t("reasonChoose")}</option>
          {RETURN_REASONS.map((r) => <option key={r} value={r}>{tr(r)}</option>)}
        </Select>
      </Field>
      <Field label={t("note")} htmlFor="ret-note" hint={t("noteHint")} error={fieldErr(state, "note")}>
        <Textarea id="ret-note" name="note" maxLength={500} />
      </Field>
      <div><Button type="submit" disabled={pending}>{pending ? t("pending") : t("submit")}</Button></div>
    </form>
  );
}

export function CancelReturnForm({ returnId }: { returnId: string }) {
  const t = useTranslations("grn.returnDetail");
  const [state, action, pending] = useActionState<State, FormData>(cancelReturnAction, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="returnId" value={returnId} />
      <Result state={state} />
      <div><Button type="submit" variant="outline" disabled={pending}>{t("cancel")}</Button></div>
    </form>
  );
}

export function ShipReturnForm({ returnId }: { returnId: string }) {
  const t = useTranslations("grn.ship");
  const [state, action, pending] = useActionState<State, FormData>(shipReturnAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="returnId" value={returnId} />
      <Result state={state} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("courier")} htmlFor="ship-courier" error={fieldErr(state, "courier")}>
          <Input id="ship-courier" name="courier" maxLength={60} autoComplete="off" />
        </Field>
        <Field label={t("tracking")} htmlFor="ship-tracking" hint={t("trackingHint")} error={fieldErr(state, "trackingRef")}>
          <Input id="ship-tracking" name="trackingRef" required minLength={3} maxLength={40} autoComplete="off" />
        </Field>
      </div>
      <div><Button type="submit" disabled={pending}>{pending ? t("pending") : t("submit")}</Button></div>
    </form>
  );
}

/** Open a dispute about a rejected return (the dispute is handled by the disputes module; the return links to it). */
export function ReturnDisputeForm({ returnId }: { returnId: string }) {
  const t = useTranslations("grn.dispute");
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionResult<{ disputeId: string }> | null, FormData>(async (prev, fd) => {
    const r = await returnDisputeAction(prev, fd);
    if (r.ok) router.push(`/buyer/disputes/${r.data.disputeId}`);
    return r;
  }, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="returnId" value={returnId} />
      <p className="text-sm text-muted">{t("intro")}</p>
      <Result state={state} />
      <Field label={t("text")} htmlFor="rd-text" error={fieldErr(state, "text")}>
        <Textarea id="rd-text" name="text" maxLength={1000} />
      </Field>
      <div><Button type="submit" disabled={pending}>{pending ? t("pending") : t("submit")}</Button></div>
    </form>
  );
}
