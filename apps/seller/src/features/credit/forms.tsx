"use client";
import { useActionState, useId } from "react";
import { useTranslations } from "next-intl";
import { Alert, Button, Field, Input, Select } from "@cnote/ui";
import { creditAction, type CreditResult } from "./actions";

function useCredit() {
  return useActionState<CreditResult | null, FormData>(creditAction, null);
}
function Status({ state }: { state: CreditResult | null }) {
  const t = useTranslations("credit");
  return (
    <div role="status" aria-live="polite">
      {state && !state.ok ? <Alert tone="danger">{state.error || t("error")}</Alert> : null}
    </div>
  );
}

export function ConsentForm({ granted }: { granted: boolean }) {
  const t = useTranslations("credit");
  const [state, action, pending] = useCredit();
  return (
    <form action={action} className="flex flex-col gap-3" aria-busy={pending}>
      <input type="hidden" name="intent" value={granted ? "withdraw" : "grant"} />
      <Status state={state} />
      <div><Button type="submit" variant={granted ? "outline" : "primary"} disabled={pending} className="min-h-11">{granted ? t("consent.withdraw") : t("consent.grant")}</Button></div>
    </form>
  );
}

export function ApplyForm({ escrowId, maxRupees, tenors, disabled }: { escrowId: string; maxRupees: number; tenors: readonly number[]; disabled?: boolean }) {
  const t = useTranslations("credit");
  const [state, action, pending] = useCredit();
  const id = useId();
  return (
    <form action={action} className="flex flex-col gap-3" aria-busy={pending}>
      <input type="hidden" name="intent" value="apply" />
      <input type="hidden" name="escrowId" value={escrowId} />
      <Status state={state} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("eligible.amount")} htmlFor={`${id}-amt`}>
          <Input id={`${id}-amt`} name="amountRupees" type="number" inputMode="decimal" min={1} max={maxRupees} step="0.01" defaultValue={maxRupees} required />
        </Field>
        <Field label={t("eligible.tenor")} htmlFor={`${id}-tenor`}>
          <Select id={`${id}-tenor`} name="tenorDays" defaultValue="30">{tenors.map((d) => <option key={d} value={d}>{t("eligible.days", { days: d })}</option>)}</Select>
        </Field>
      </div>
      <div><Button type="submit" disabled={pending || disabled} className="min-h-11">{t("eligible.apply")}</Button></div>
    </form>
  );
}

export function AcceptForm({ offerId, kfsVersion, lender }: { offerId: string; kfsVersion: string; lender: string }) {
  const t = useTranslations("credit");
  const [state, action, pending] = useCredit();
  const id = useId();
  return (
    <form action={action} className="flex flex-col gap-3" aria-busy={pending}>
      <input type="hidden" name="offerId" value={offerId} />
      <input type="hidden" name="kfsVersion" value={kfsVersion} />
      <Status state={state} />
      <label htmlFor={`${id}-ack`} className="flex min-h-11 items-start gap-2 text-sm text-ink">
        <input id={`${id}-ack`} type="checkbox" name="acknowledge" required className="mt-1 size-5" />
        <span>{t("accept.acknowledge", { lender })}</span>
      </label>
      <p className="text-sm text-muted">{t("accept.noAuto")}</p>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" name="intent" value="accept" disabled={pending} className="min-h-11">{t("accept.submit")}</Button>
        <Button type="submit" name="intent" value="decline" variant="outline" formNoValidate disabled={pending} className="min-h-11">{t("accept.decline")}</Button>
      </div>
    </form>
  );
}

export function SimulateForm({ applicationId }: { applicationId: string }) {
  const t = useTranslations("credit");
  const [state, action, pending] = useCredit();
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="intent" value="simulate" />
      <input type="hidden" name="applicationId" value={applicationId} />
      <Status state={state} />
      <div><Button type="submit" variant="outline" disabled={pending} className="min-h-11">{t("dev.simulate")}</Button></div>
    </form>
  );
}
