"use client";
// Client UI for WebAuthn passkeys (docs/design/admin-passkeys.md). Realm-neutral: the server actions resolve the realm.
//  * <PasskeySignInButton/>  sign-in step: "Use passkey" (primary) next to the authenticator-code form
//  * <PasskeyEnrollPanel/>   forced enrollment after TOTP when <REALM>_REQUIRE_PASSKEY is on
//  * <PasskeySettings/>      account security card: list, rename, add, revoke (step-up)
// The browser ceremony is @simplewebauthn/browser; everything verifiable happens server-side.
import { Alert, Badge, Button, Card, CardBody, Field, Input } from "@cnote/ui";
import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnError } from "@simplewebauthn/browser";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ActionResult } from "./action-result";
import {
  mfaCancelAction, passkeyEnrollOptionsAction, passkeyEnrollVerifyAction, passkeyListAction, passkeyLoginOptionsAction, passkeyLoginVerifyAction,
  passkeyRegisterOptionsAction, passkeyRegisterVerifyAction, passkeyRenameAction, passkeyRevokeAction, passkeyStepUpOptionsAction,
  type PasskeySettingsData,
} from "./mfa-actions";

export const DEFAULT_PASSKEY_LABELS = {
  usePasskey: "Sign in with a passkey",
  usePasskeyHint: "Uses your fingerprint, face, screen lock or security key. Nothing to type, and it cannot be phished.",
  working: "Waiting for your device…",
  orCode: "Or use an authenticator code",
  unsupported: "This browser does not support passkeys. Use a current browser or an authenticator code.",
  cancelled: "The passkey prompt was cancelled or timed out. Try again.",
  enrollTitle: "Create a passkey",
  enrollBody: "Your organisation requires a passkey for back-office access. Create one on this device or a security key to finish signing in.",
  nickname: "Name this passkey",
  nicknameHint: "For example: Work laptop, YubiKey.",
  create: "Create passkey",
  cancel: "Cancel sign-in",
  settingsTitle: "Passkeys",
  settingsIntro: "Passkeys are tied to the real site address, so a fake sign-in page cannot capture them. Register at least two (for example this device and a security key).",
  none: "No passkeys yet.",
  add: "Add a passkey",
  confirmWithCode: "Authenticator or recovery code",
  confirmWithCodeHint: "Needed to confirm it is you. If you already have a passkey you will be asked to use it instead.",
  rename: "Rename",
  save: "Save",
  revoke: "Remove",
  removeConfirm: "Remove this passkey? You will not be able to sign in with it again.",
  createdOn: "Added",
  lastUsed: "last used",
  neverUsed: "never used",
  synced: "synced",
  deviceBound: "this device only",
  requiredNote: "Your organisation requires a passkey. The last one cannot be removed.",
  disabled: "Passkeys are not enabled for this app.",
} as const;
export type PasskeyLabels = { [K in keyof typeof DEFAULT_PASSKEY_LABELS]: string };

interface Props {
  labels?: Partial<PasskeyLabels>;
}
const merge = (l?: Partial<PasskeyLabels>): PasskeyLabels => ({ ...DEFAULT_PASSKEY_LABELS, ...l });

/** Turn a ceremony failure into a message: user cancellation is routine, everything else shows the server/browser text. */
function ceremonyError(err: unknown, L: PasskeyLabels): string {
  if (err instanceof WebAuthnError && (err.code === "ERROR_CEREMONY_ABORTED" || err.code === "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY")) return L.cancelled;
  if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError")) return L.cancelled;
  return err instanceof Error ? err.message : L.cancelled;
}
const failure = (r: ActionResult<unknown>) => (r.ok ? "" : r.error);

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

/** Sign-in step: primary passkey button. Place above the authenticator-code form. */
export function PasskeySignInButton({ labels }: Props) {
  const L = merge(labels);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [supported, setSupported] = useState(true);
  useEffect(() => setSupported(browserSupportsWebAuthn()), []);

  async function go() {
    setError(undefined);
    setBusy(true);
    try {
      const opts = await passkeyLoginOptionsAction();
      if (!opts.ok) return setError(failure(opts));
      const assertion = await startAuthentication({ optionsJSON: opts.data });
      const done = await passkeyLoginVerifyAction(assertion);
      if (!done.ok) return setError(failure(done));
      window.location.assign(done.data.next); // hard navigation: the auth cookies were just set
    } catch (err) {
      setError(ceremonyError(err, L));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!supported ? <Alert tone="warning">{L.unsupported}</Alert> : null}
      <Button type="button" size="lg" onClick={go} disabled={busy || !supported}>{busy ? L.working : L.usePasskey}</Button>
      <p className="text-sm text-muted">{L.usePasskeyHint}</p>
    </div>
  );
}

/** Forced enrollment (policy): the session stays parked until a passkey is registered. */
export function PasskeyEnrollPanel({ labels }: Props) {
  const L = merge(labels);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [name, setName] = useState("");
  async function go() {
    setError(undefined);
    setBusy(true);
    try {
      const opts = await passkeyEnrollOptionsAction();
      if (!opts.ok) return setError(failure(opts));
      const att = await startRegistration({ optionsJSON: opts.data });
      const done = await passkeyEnrollVerifyAction(att, name);
      if (!done.ok) return setError(failure(done));
      window.location.assign(done.data.next);
    } catch (err) {
      setError(ceremonyError(err, L));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title={L.enrollTitle} error={error}>
      <Alert tone="info">{L.enrollBody}</Alert>
      <Field label={L.nickname} htmlFor="passkey-name" hint={L.nicknameHint}>
        <Input id="passkey-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </Field>
      <Button type="button" size="lg" onClick={go} disabled={busy}>{busy ? L.working : L.create}</Button>
      <form action={mfaCancelAction}>
        <Button type="submit" variant="ghost" className="w-full">{L.cancel}</Button>
      </form>
    </Panel>
  );
}

/** Account security card: list, rename, add, revoke. Sensitive changes need step-up (existing passkey, else a code). */
export function PasskeySettings({ labels }: Props) {
  const L = merge(labels);
  const [data, setData] = useState<PasskeySettingsData | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

  const refresh = useCallback(async () => {
    const r = await passkeyListAction();
    if (r.ok) setData(r.data);
    else setError(failure(r));
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** A fresh proof: an assertion from an existing passkey when there is one, otherwise the typed code. */
  async function stepUp(): Promise<{ assertion: Awaited<ReturnType<typeof startAuthentication>> } | { code: string }> {
    if (data && data.passkeys.length > 0) {
      const o = await passkeyStepUpOptionsAction();
      if (!o.ok) throw new Error(failure(o));
      return { assertion: await startAuthentication({ optionsJSON: o.data }) };
    }
    if (!code.trim()) throw new Error(L.confirmWithCode);
    return { code: code.trim() };
  }

  async function run(fn: () => Promise<void>) {
    setError(undefined);
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(ceremonyError(err, L));
    } finally {
      setBusy(false);
    }
  }

  const add = () =>
    run(async () => {
      const proof = await stepUp();
      const o = await passkeyRegisterOptionsAction(proof);
      if (!o.ok) throw new Error(failure(o));
      const att = await startRegistration({ optionsJSON: o.data });
      const done = await passkeyRegisterVerifyAction(att, name);
      if (!done.ok) throw new Error(failure(done));
      setName("");
      setCode("");
    });
  const revoke = (id: string) =>
    run(async () => {
      if (!window.confirm(L.removeConfirm)) return;
      const r = await passkeyRevokeAction(id, await stepUp());
      if (!r.ok) throw new Error(failure(r));
      setCode("");
    });
  const rename = () =>
    run(async () => {
      if (!renaming) return;
      const r = await passkeyRenameAction(renaming.id, renaming.value);
      if (!r.ok) throw new Error(failure(r));
      setRenaming(null);
    });

  if (data && !data.enabled) return <Panel title={L.settingsTitle}><p className="text-sm text-muted">{L.disabled}</p></Panel>;
  const fmt = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  return (
    <Card className="w-full">
      <CardBody className="flex flex-col gap-4 p-6">
        <h2 className="text-lg font-semibold">{L.settingsTitle}</h2>
        <p className="text-sm text-muted">{L.settingsIntro}</p>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {data?.required ? <Alert tone="info">{L.requiredNote}</Alert> : null}
        {data && data.passkeys.length === 0 ? <p className="text-sm">{L.none}</p> : null}
        <ul className="flex flex-col gap-3" aria-label={L.settingsTitle}>
          {data?.passkeys.map((k) => (
            <li key={k.id} className="flex flex-col gap-2 rounded border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                {renaming?.id === k.id ? (
                  <>
                    <label className="sr-only" htmlFor={`rn-${k.id}`}>{L.rename}</label>
                    <Input id={`rn-${k.id}`} value={renaming.value} maxLength={40} onChange={(e) => setRenaming({ id: k.id, value: e.target.value })} className="max-w-56" />
                    <Button type="button" size="sm" onClick={rename} disabled={busy}>{L.save}</Button>
                  </>
                ) : (
                  <>
                    <strong>{k.nickname}</strong>
                    <Badge tone="neutral">{k.deviceType === "multiDevice" || k.backedUp ? L.synced : L.deviceBound}</Badge>
                  </>
                )}
              </div>
              <p className="text-xs text-muted">{L.createdOn} {fmt(k.createdAt)} · {k.lastUsedAt ? `${L.lastUsed} ${fmt(k.lastUsedAt)}` : L.neverUsed}</p>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setRenaming({ id: k.id, value: k.nickname })}>{L.rename}</Button>
                <Button type="button" size="sm" variant="ghost" className="text-danger" disabled={busy || (data.required && data.passkeys.length <= 1)} onClick={() => revoke(k.id)}>{L.revoke}</Button>
              </div>
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <Field label={L.nickname} htmlFor="new-passkey-name" hint={L.nicknameHint}>
            <Input id="new-passkey-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </Field>
          {data && data.passkeys.length === 0 ? (
            <Field label={L.confirmWithCode} htmlFor="passkey-stepup-code" hint={L.confirmWithCodeHint}>
              <Input id="passkey-stepup-code" value={code} maxLength={16} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" spellCheck={false} />
            </Field>
          ) : null}
          <Button type="button" onClick={add} disabled={busy || !data}>{busy ? L.working : L.add}</Button>
        </div>
      </CardBody>
    </Card>
  );
}
