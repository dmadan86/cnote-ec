"use client";
import { Alert, Button, Field, Input } from "@cnote/ui";
import { useState } from "react";
import { autoAcceptAction, mandateStatusAction } from "./actions";
import { ActionMessage, text } from "./action-message";
import { fmt, type A2aLabels } from "./labels";
import { useA2aAction } from "./use-a2a-action";

/** Pause / resume, and revoke behind an explicit second step (revoke is irreversible and withdraws open negotiations). */
export function MandateStatusControls({ id, status, t }: { id: string; status: string; t: A2aLabels }) {
  const { state, pending, onSubmit } = useA2aAction(mandateStatusAction);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const canPause = status === "active";
  const canResume = status === "paused";
  const canRevoke = ["active", "paused", "suspended", "expired", "completed"].includes(status);
  return (
    <section aria-labelledby="mc-ctl-h" className="flex flex-col gap-3">
      <h2 id="mc-ctl-h" className="text-lg font-bold text-ink">{t.controlsHeading}</h2>
      <div className="flex flex-wrap gap-3">
        {canPause || canResume ? (
          <form onSubmit={onSubmit}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="intent" value={canPause ? "pause" : "resume"} />
            <Button type="submit" variant="outline" disabled={pending} aria-busy={pending} className="min-h-11">{pending ? t.working : canPause ? t.pause : t.resume}</Button>
          </form>
        ) : null}
        {canRevoke && !confirmRevoke ? (
          <Button type="button" variant="outline" onClick={() => setConfirmRevoke(true)} aria-expanded={false} aria-controls="mc-revoke" className="min-h-11">{t.revoke}</Button>
        ) : null}
      </div>
      {confirmRevoke ? (
        <form id="mc-revoke" onSubmit={onSubmit} className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="intent" value="revoke" />
          <p className="text-sm text-ink">{t.revokeWarn}</p>
          <div className="flex flex-wrap gap-3">
            <Button type="submit" variant="danger" disabled={pending} aria-busy={pending} className="min-h-11">{pending ? t.working : t.revokeYes}</Button>
            <Button type="button" variant="outline" onClick={() => setConfirmRevoke(false)} className="min-h-11">{t.cancel}</Button>
          </div>
        </form>
      ) : null}
      <ActionMessage state={state} t={t} />
    </section>
  );
}

/** Auto-accept: off is ONE click; on needs an explicit consent tick and a ceiling that is not above the maximum price. */
export function AutoAcceptControl({ id, enabled, limitLabel, maxHint, canChange, t }: { id: string; enabled: boolean; limitLabel: string | null; maxHint: string | null; canChange: boolean; t: A2aLabels }) {
  const { state, pending, onSubmit } = useA2aAction(autoAcceptAction);
  const [open, setOpen] = useState(false);
  const errors: Record<string, string> = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const e = (k: string) => (errors[k] ? text(t, errors[k]) : undefined);
  return (
    <section aria-labelledby="ma-h" className="flex flex-col gap-3">
      <h2 id="ma-h" className="text-lg font-bold text-ink">{t.autoHeading}</h2>
      <p className="text-sm text-ink">{enabled && limitLabel ? fmt(t.autoIsOn, { limit: limitLabel }) : t.autoIsOff}</p>
      {canChange && enabled ? (
        <form onSubmit={onSubmit}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="intent" value="off" />
          <Button type="submit" variant="primary" disabled={pending} aria-busy={pending} className="min-h-11">{pending ? t.working : t.autoTurnOff}</Button>
        </form>
      ) : null}
      {canChange && !enabled && !open ? (
        <div>
          <Button type="button" variant="outline" onClick={() => setOpen(true)} aria-expanded={false} aria-controls="ma-on" className="min-h-11">{t.autoTurnOn}</Button>
        </div>
      ) : null}
      {canChange && !enabled && open ? (
        <form id="ma-on" onSubmit={onSubmit} noValidate className="flex flex-col gap-3 rounded-lg border border-line bg-canvas p-4">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="intent" value="on" />
          <Field label={t.fAutoLimit} htmlFor="ma-limit" hint={maxHint ? `${t.fAutoLimitHint} (${maxHint})` : t.fAutoLimitHint} error={e("autoLimit")}>
            <Input id="ma-limit" name="autoLimit" inputMode="decimal" autoComplete="off" required className="min-h-11" />
          </Field>
          <div>
            <label className="flex min-h-11 items-start gap-3 text-sm text-ink">
              <input type="checkbox" name="autoConsent" required aria-invalid={e("autoConsent") ? true : undefined} aria-describedby={e("autoConsent") ? "ma-consent-err" : undefined} className="mt-0.5 h-6 w-6 shrink-0 accent-brand-600" />
              <span>{t.fAutoConsent}</span>
            </label>
            {e("autoConsent") ? <p id="ma-consent-err" role="alert" className="ml-9 text-xs text-danger">{e("autoConsent")}</p> : null}
          </div>
          <div className="flex flex-wrap gap-3">
            <Button type="submit" variant="primary" disabled={pending} aria-busy={pending} className="min-h-11">{pending ? t.working : t.autoTurnOn}</Button>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} className="min-h-11">{t.cancel}</Button>
          </div>
        </form>
      ) : null}
      <ActionMessage state={state && (state.ok || !state.fieldErrors) ? state : null} t={t} />
      {state && !state.ok && state.fieldErrors ? <Alert tone="danger">{text(t, state.error)}</Alert> : null}
    </section>
  );
}
