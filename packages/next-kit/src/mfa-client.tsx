"use client";
// Client UI for two-factor authentication. Sign-in step: <MfaChallengeForm/> (code or recovery code) and
// <MfaEnrollForm/> (forced first-time setup, e.g. admin). Account settings: <MfaSettings/>.
// The authenticator secret is shown as a setup key plus an otpauth:// link (no QR dependency).
import { Alert, Button, Card, CardBody, Field, Input } from "@cnote/ui";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition, type ReactNode } from "react";
import type { ActionResult } from "./action-result";
import { localizeError } from "./error-catalogue";
import { fillSlot } from "./fill-slot";
import { DEFAULT_MFA_LABELS, type MfaLabels } from "./mfa-labels";

import {
  mfaBeginAction, mfaCancelAction, mfaChallengeAction, mfaConfirmAction, mfaDisableAction, mfaEnrollConfirmAction, mfaFinishAction, mfaRegenerateAction,
} from "./mfa-actions";

export { DEFAULT_MFA_LABELS, type MfaLabels } from "./mfa-labels";

/** Props every MFA form takes: translated labels (partial, English fallback) and an error-key translator. */
export interface MfaLocaleProps {
  labels?: Partial<MfaLabels>;
  translateError?: (key: string) => string | undefined;
}

type Codes = { recoveryCodes: string[] };
const errorOf = (s: ActionResult<unknown> | null, tr?: MfaLocaleProps["translateError"]) => (s && !s.ok ? (tr ? localizeError(s, tr) : s.error) : undefined);
const mergeLabels = (labels?: Partial<MfaLabels>): MfaLabels => ({ ...DEFAULT_MFA_LABELS, ...labels });

function Panel({ title, children, error }: { title: string; children: ReactNode; error?: string }) {
  return (
    <Card className="mx-auto w-full max-w-md">
      <CardBody className="flex flex-col gap-4 p-6">
        <h1 className="text-lg font-semibold">{title}</h1>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {children}
      </CardBody>
    </Card>
  );
}

function CodeField({ id = "code", label, hint }: { id?: string; label: string; hint?: string }) {
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <Input id={id} name="code" inputMode="text" autoComplete="one-time-code" autoFocus required maxLength={16} spellCheck={false} />
    </Field>
  );
}

function SetupKey({ manualKey, otpauthUri, L }: { manualKey: string; otpauthUri: string; L: MfaLabels }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>{fillSlot(L.setupKeyIntro, "key", <strong>{L.setupKeyName}</strong>)}</p>
      <code className="select-all break-all rounded bg-canvas px-3 py-2 font-mono text-base tracking-wider" aria-label={L.setupKeyAria}>{manualKey}</code>
      <p className="text-muted">
        {fillSlot(L.setupLinkIntro, "link", <a className="font-medium text-brand-700 underline" href={otpauthUri}>{L.setupLinkText}</a>)}
      </p>
    </div>
  );
}

function RecoveryCodes({ codes, L, children }: { codes: string[]; L: MfaLabels; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <Alert tone="warning">{L.recoveryWarning}</Alert>
      <ul className="grid grid-cols-2 gap-2 rounded bg-canvas p-3 font-mono text-sm" aria-label={L.recoveryAria}>
        {codes.map((c) => (
          <li key={c} className="select-all">{c}</li>
        ))}
      </ul>
      {children}
    </div>
  );
}

/** Sign-in step for a person with MFA enabled. */
export function MfaChallengeForm({ labels, translateError }: MfaLocaleProps = {}) {
  const L = mergeLabels(labels);
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(mfaChallengeAction, null);
  return (
    <Panel title={L.title} error={errorOf(state, translateError)}>
      <form action={action} className="flex flex-col gap-4" noValidate>
        <CodeField label={L.codeLabel} hint={L.challengeHint} />
        <Button type="submit" size="lg" disabled={pending}>{pending ? L.verifying : L.verify}</Button>
      </form>
      <form action={mfaCancelAction}>
        <Button type="submit" variant="ghost" className="w-full">{L.cancelSignIn}</Button>
      </form>
    </Panel>
  );
}

/** Forced first-time setup during sign-in (admin realm). The session is only issued once this completes. */
export function MfaEnrollForm({ manualKey, otpauthUri, done, labels, translateError }: { manualKey: string; otpauthUri: string; done?: boolean } & MfaLocaleProps) {
  const L = mergeLabels(labels);
  const [state, action, pending] = useActionState<ActionResult<Codes> | null, FormData>(mfaEnrollConfirmAction, null);
  if (done && !state?.ok) {
    return (
      <Panel title={L.onTitle}>
        <p className="text-sm text-muted">{L.enrolledBody}</p>
        <form action={mfaFinishAction}>
          <Button type="submit" size="lg" className="w-full">{L.continue}</Button>
        </form>
      </Panel>
    );
  }
  if (state?.ok) {
    return (
      <Panel title={L.onTitle}>
        <RecoveryCodes codes={state.data.recoveryCodes} L={L}>
          <form action={mfaFinishAction}>
            <Button type="submit" size="lg" className="w-full">{L.savedContinue}</Button>
          </form>
        </RecoveryCodes>
      </Panel>
    );
  }
  return (
    <Panel title={L.setupTitle} error={errorOf(state, translateError)}>
      <Alert tone="info">{L.enrollNotice}</Alert>
      <SetupKey manualKey={manualKey} otpauthUri={otpauthUri} L={L} />
      <form action={action} className="flex flex-col gap-4" noValidate>
        <Field label={L.sixDigit} htmlFor="code" hint={L.currentCodeHint}>
          <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} required spellCheck={false} />
        </Field>
        <Button type="submit" size="lg" disabled={pending}>{pending ? L.checking : L.turnOn}</Button>
      </form>
      <form action={mfaCancelAction}>
        <Button type="submit" variant="ghost" className="w-full">{L.cancel}</Button>
      </form>
    </Panel>
  );
}

export interface MfaSettingsProps {
  enabled: boolean;
  recoveryCodesLeft: number;
  /** Admins cannot switch MFA off. */
  required?: boolean;
}

/** Account security card: enable, disable, regenerate recovery codes. */
export function MfaSettings({ enabled, recoveryCodesLeft, required, labels, translateError }: MfaSettingsProps & MfaLocaleProps) {
  const L = mergeLabels(labels);
  const router = useRouter();
  const [setup, setSetup] = useState<{ otpauthUri: string; manualKey: string } | null>(null);
  const [beginError, setBeginError] = useState<string>();
  const [starting, startTransition] = useTransition();
  const [confirmState, confirm, confirming] = useActionState<ActionResult<Codes> | null, FormData>(async (p, fd) => {
    const r = await mfaConfirmAction(p, fd);
    if (r.ok) router.refresh();
    return r;
  }, null);
  const [disableState, disable, disabling] = useActionState<ActionResult | null, FormData>(async (p, fd) => {
    const r = await mfaDisableAction(p, fd);
    if (r.ok) router.refresh();
    return r;
  }, null);
  const [regenState, regenerate, regenerating] = useActionState<ActionResult<Codes> | null, FormData>(mfaRegenerateAction, null);

  if (confirmState?.ok) {
    return (
      <Panel title={L.onTitle}>
        <RecoveryCodes codes={confirmState.data.recoveryCodes} L={L} />
      </Panel>
    );
  }
  if (!enabled) {
    return (
      <Panel title={L.title} error={beginError ?? errorOf(confirmState, translateError)}>
        <p className="text-sm text-muted">{L.settingsIntro} {required ? L.requiredForRole : L.recommended}</p>
        {setup ? (
          <>
            <SetupKey {...setup} L={L} />
            <form action={confirm} className="flex flex-col gap-4" noValidate>
              <Field label={L.sixDigit} htmlFor="mfa-confirm" hint={L.currentCodeHint}>
                <Input id="mfa-confirm" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} required spellCheck={false} />
              </Field>
              <Button type="submit" disabled={confirming}>{confirming ? L.checking : L.turnOn}</Button>
            </form>
          </>
        ) : (
          <Button
            disabled={starting}
            onClick={() =>
              startTransition(async () => {
                const r = await mfaBeginAction();
                if (r.ok) setSetup(r.data);
                else setBeginError(translateError ? localizeError(r, translateError) : r.error);
              })
            }
          >
            {starting ? L.preparing : L.setUp}
          </Button>
        )}
      </Panel>
    );
  }
  return (
    <Panel title={L.title} error={errorOf(disableState, translateError) ?? errorOf(regenState, translateError)}>
      <Alert tone="success">{L.onNotice.replace("{count}", String(recoveryCodesLeft))}</Alert>
      {regenState?.ok ? <RecoveryCodes codes={regenState.data.recoveryCodes} L={L} /> : null}
      <form action={regenerate} className="flex flex-col gap-3" noValidate>
        <CodeField id="mfa-regen" label={L.confirmCode} hint={L.regenHint} />
        <Button type="submit" variant="outline" disabled={regenerating}>{regenerating ? L.working : L.regenerate}</Button>
      </form>
      {required ? (
        <p className="text-sm text-muted">{L.cannotDisable}</p>
      ) : (
        <form action={disable} className="flex flex-col gap-3" noValidate>
          <CodeField id="mfa-disable" label={L.turnOffCode} />
          <Button type="submit" variant="outline" disabled={disabling}>{disabling ? L.working : L.turnOff}</Button>
        </form>
      )}
    </Panel>
  );
}
