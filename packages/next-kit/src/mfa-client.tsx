"use client";
// Client UI for two-factor authentication. Sign-in step: <MfaChallengeForm/> (code or recovery code) and
// <MfaEnrollForm/> (forced first-time setup, e.g. admin). Account settings: <MfaSettings/>.
// The authenticator secret is shown as a setup key plus an otpauth:// link (no QR dependency).
import { Alert, Button, Card, CardBody, Field, Input } from "@cnote/ui";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition, type ReactNode } from "react";
import type { ActionResult } from "./action-result";
import {
  mfaBeginAction, mfaCancelAction, mfaChallengeAction, mfaConfirmAction, mfaDisableAction, mfaEnrollConfirmAction, mfaFinishAction, mfaRegenerateAction,
} from "./mfa-actions";

type Codes = { recoveryCodes: string[] };
const errorOf = (s: ActionResult<unknown> | null) => (s && !s.ok ? s.error : undefined);

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

function CodeField({ id = "code", label = "Authentication code", hint }: { id?: string; label?: string; hint?: string }) {
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <Input id={id} name="code" inputMode="text" autoComplete="one-time-code" autoFocus required maxLength={16} spellCheck={false} />
    </Field>
  );
}

function SetupKey({ manualKey, otpauthUri }: { manualKey: string; otpauthUri: string }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        In your authenticator app (Google Authenticator, 1Password, Authy…) choose <strong>Enter a setup key</strong> and type:
      </p>
      <code className="select-all break-all rounded bg-canvas px-3 py-2 font-mono text-base tracking-wider" aria-label="Setup key">{manualKey}</code>
      <p className="text-muted">
        On a phone with an authenticator installed you can also <a className="font-medium text-brand-700 underline" href={otpauthUri}>open the setup link</a>.
      </p>
    </div>
  );
}

function RecoveryCodes({ codes, children }: { codes: string[]; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <Alert tone="warning">Save these recovery codes somewhere safe. Each works once if you lose your authenticator. They won&apos;t be shown again.</Alert>
      <ul className="grid grid-cols-2 gap-2 rounded bg-canvas p-3 font-mono text-sm" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c} className="select-all">{c}</li>
        ))}
      </ul>
      {children}
    </div>
  );
}

/** Sign-in step for a person with MFA enabled. */
export function MfaChallengeForm() {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(mfaChallengeAction, null);
  return (
    <Panel title="Two-factor authentication" error={errorOf(state)}>
      <form action={action} className="flex flex-col gap-4" noValidate>
        <CodeField hint="Enter the 6-digit code from your authenticator app, or a recovery code." />
        <Button type="submit" size="lg" disabled={pending}>{pending ? "Verifying…" : "Verify"}</Button>
      </form>
      <form action={mfaCancelAction}>
        <Button type="submit" variant="ghost" className="w-full">Cancel and sign in again</Button>
      </form>
    </Panel>
  );
}

/** Forced first-time setup during sign-in (admin realm). The session is only issued once this completes. */
export function MfaEnrollForm({ manualKey, otpauthUri, done }: { manualKey: string; otpauthUri: string; done?: boolean }) {
  const [state, action, pending] = useActionState<ActionResult<Codes> | null, FormData>(mfaEnrollConfirmAction, null);
  if (done && !state?.ok) {
    return (
      <Panel title="Two-factor authentication is on">
        <p className="text-sm text-muted">Your authenticator is set up. You can create new recovery codes later under Account, then Security.</p>
        <form action={mfaFinishAction}>
          <Button type="submit" size="lg" className="w-full">Continue</Button>
        </form>
      </Panel>
    );
  }
  if (state?.ok) {
    return (
      <Panel title="Two-factor authentication is on">
        <RecoveryCodes codes={state.data.recoveryCodes}>
          <form action={mfaFinishAction}>
            <Button type="submit" size="lg" className="w-full">I&apos;ve saved them. Continue</Button>
          </form>
        </RecoveryCodes>
      </Panel>
    );
  }
  return (
    <Panel title="Set up two-factor authentication" error={errorOf(state)}>
      <Alert tone="info">Back-office access requires a second factor. Set it up once; you&apos;ll be asked for a code at every sign-in.</Alert>
      <SetupKey manualKey={manualKey} otpauthUri={otpauthUri} />
      <form action={action} className="flex flex-col gap-4" noValidate>
        <Field label="6-digit code" htmlFor="code" hint="Enter the current code shown in the app.">
          <Input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} required spellCheck={false} />
        </Field>
        <Button type="submit" size="lg" disabled={pending}>{pending ? "Checking…" : "Turn on two-factor"}</Button>
      </form>
      <form action={mfaCancelAction}>
        <Button type="submit" variant="ghost" className="w-full">Cancel</Button>
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
export function MfaSettings({ enabled, recoveryCodesLeft, required }: MfaSettingsProps) {
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
      <Panel title="Two-factor authentication is on">
        <RecoveryCodes codes={confirmState.data.recoveryCodes} />
      </Panel>
    );
  }
  if (!enabled) {
    return (
      <Panel title="Two-factor authentication" error={beginError ?? errorOf(confirmState)}>
        <p className="text-sm text-muted">Add a second step to sign-in using an authenticator app. {required ? "It is required for your role." : "Recommended for anyone who can spend credits or edit listings."}</p>
        {setup ? (
          <>
            <SetupKey {...setup} />
            <form action={confirm} className="flex flex-col gap-4" noValidate>
              <Field label="6-digit code" htmlFor="mfa-confirm" hint="Enter the current code shown in the app.">
                <Input id="mfa-confirm" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} required spellCheck={false} />
              </Field>
              <Button type="submit" disabled={confirming}>{confirming ? "Checking…" : "Turn on two-factor"}</Button>
            </form>
          </>
        ) : (
          <Button
            disabled={starting}
            onClick={() =>
              startTransition(async () => {
                const r = await mfaBeginAction();
                if (r.ok) setSetup(r.data);
                else setBeginError(r.error);
              })
            }
          >
            {starting ? "Preparing…" : "Set up two-factor"}
          </Button>
        )}
      </Panel>
    );
  }
  return (
    <Panel title="Two-factor authentication" error={errorOf(disableState) ?? errorOf(regenState)}>
      <Alert tone="success">Two-factor authentication is on. Recovery codes left: {recoveryCodesLeft}.</Alert>
      {regenState?.ok ? <RecoveryCodes codes={regenState.data.recoveryCodes} /> : null}
      <form action={regenerate} className="flex flex-col gap-3" noValidate>
        <CodeField id="mfa-regen" label="Code to confirm" hint="A current code is needed to make new recovery codes (the old ones stop working)." />
        <Button type="submit" variant="outline" disabled={regenerating}>{regenerating ? "Working…" : "Generate new recovery codes"}</Button>
      </form>
      {required ? (
        <p className="text-sm text-muted">Two-factor cannot be turned off for back-office accounts.</p>
      ) : (
        <form action={disable} className="flex flex-col gap-3" noValidate>
          <CodeField id="mfa-disable" label="Code to turn off" />
          <Button type="submit" variant="outline" disabled={disabling}>{disabling ? "Working…" : "Turn off two-factor"}</Button>
        </form>
      )}
    </Panel>
  );
}
