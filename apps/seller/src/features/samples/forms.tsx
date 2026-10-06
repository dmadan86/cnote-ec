"use client";
import { useActionState, useId } from "react";
import { useTranslations } from "next-intl";
import { Alert, Button, Field, Input, Select, Textarea } from "@cnote/ui";
import type { ActionResult } from "@cnote/next-kit";
import { sampleAction } from "./actions";

const DECLINE_REASONS = ["out_of_stock", "not_offered", "buyer_tier", "region_not_served", "quantity_too_high", "other"] as const;

function Head({ intent, sampleId, state }: { intent: string; sampleId: string; state: ActionResult | null }) {
  const t = useTranslations("samples");
  return (
    <>
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="sampleId" value={sampleId} />
      {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
      {state?.ok ? <Alert tone="success">{t("saved")}</Alert> : null}
    </>
  );
}

/** Accept: the price the buyer pays (off-platform, recorded only), whether it is adjusted against the bulk order, optional instructions. */
export function AcceptForm({ sampleId, defaultRupees }: { sampleId: string; defaultRupees: string }) {
  const t = useTranslations("samples");
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(sampleAction, null);
  const uid = useId();
  return (
    <form action={action} className="flex flex-col gap-3" aria-busy={pending}>
      <Head intent="accept" sampleId={sampleId} state={state} />
      <Field label={t("amountLabel")} htmlFor={`${uid}-amt`} hint={t("amountHint")}>
        <Input id={`${uid}-amt`} name="amountRupees" type="number" inputMode="decimal" min={0} step="0.01" defaultValue={defaultRupees} />
      </Field>
      <label className="flex min-h-11 items-center gap-2 text-sm text-ink"><input type="checkbox" name="adjustable" className="size-5" />{t("adjustableLabel")}</label>
      <Field label={t("paymentNoteLabel")} htmlFor={`${uid}-note`}>
        <Textarea id={`${uid}-note`} name="paymentNote" rows={2} maxLength={500} />
      </Field>
      <div><Button type="submit" disabled={pending}>{pending ? t("working") : t("acceptBtn")}</Button></div>
    </form>
  );
}

export function DeclineForm({ sampleId }: { sampleId: string }) {
  const t = useTranslations("samples");
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(sampleAction, null);
  const uid = useId();
  return (
    <form action={action} className="flex flex-col gap-3" aria-busy={pending}>
      <Head intent="decline" sampleId={sampleId} state={state} />
      <Field label={t("declineReason")} htmlFor={`${uid}-reason`}>
        <Select id={`${uid}-reason`} name="reason" required defaultValue="">
          <option value="" disabled />
          {DECLINE_REASONS.map((r) => <option key={r} value={r}>{t(`declineReasons.${r}`)}</option>)}
        </Select>
      </Field>
      <Field label={t("declineNoteLabel")} htmlFor={`${uid}-note`}>
        <Textarea id={`${uid}-note`} name="note" rows={2} maxLength={500} />
      </Field>
      <div><Button type="submit" variant="outline" disabled={pending}>{pending ? t("working") : t("declineBtn")}</Button></div>
    </form>
  );
}

export function DispatchForm({ sampleId }: { sampleId: string }) {
  const t = useTranslations("samples");
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(sampleAction, null);
  const uid = useId();
  return (
    <form action={action} className="flex flex-col gap-3" aria-busy={pending}>
      <Head intent="dispatch" sampleId={sampleId} state={state} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("courier")} htmlFor={`${uid}-courier`}>
          <Input id={`${uid}-courier`} name="courier" required minLength={2} maxLength={60} />
        </Field>
        <Field label={t("tracking")} htmlFor={`${uid}-track`}>
          <Input id={`${uid}-track`} name="trackingRef" maxLength={80} />
        </Field>
      </div>
      <div><Button type="submit" disabled={pending}>{pending ? t("working") : t("dispatchBtn")}</Button></div>
    </form>
  );
}

/** One-button intents: mark delivered, record the payment as received. */
export function IntentButton({ sampleId, intent, label }: { sampleId: string; intent: "delivered" | "payment"; label: string }) {
  const t = useTranslations("samples");
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(sampleAction, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <Head intent={intent} sampleId={sampleId} state={state} />
      <div><Button type="submit" variant="outline" disabled={pending}>{pending ? t("working") : label}</Button></div>
    </form>
  );
}
