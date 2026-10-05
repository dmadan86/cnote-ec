"use server";
// Server actions for the MFA step of sign-in (pending-cookie based) and for the account security settings
// (session based). Only async functions may be exported from a "use server" module.
import {
  beginMfaEnrollment, beginPasskeyAuthentication, beginPasskeyRegistration, confirmMfaEnrollment, disableMfa, finishPasskeyAuthentication, finishPasskeyRegistration,
  listPasskeys, mfaStatus, passkeyPolicy, regenerateRecoveryCodes, renamePasskey, revokePasskey, verifyMfa, verifyPasskeyStepUp,
  type AuthenticationResponseJSON, type MfaStatus, type PasskeyStepUp, type PasskeyView, type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON, type RegistrationResponseJSON,
} from "@cnote/identity";
import { redirect } from "next/navigation";
import { runAction, type ActionResult } from "./action-result";
import { getStaff, writeAudit } from "@cnote/admin";
import { DomainError } from "@cnote/core";
import { afterSecondFactor, completeMfaChallenge, discardMfaChallenge, getMfaPending, getMfaPendingAccount, MFA_PATH } from "./mfa-flow";
import { appRealm } from "./realm";
import { safeNext } from "./cookies";
import { currentSession } from "./session";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim().slice(0, 64) : "";
};
/** Admin realm only: passkey self-service and alerts also land in the append-only AdminAuditLog (privilege "self"). Best effort. */
async function auditPasskey(personId: string, action: string, details: Record<string, unknown> = {}): Promise<void> {
  if (appRealm() !== "admin") return;
  try {
    const staff = await getStaff(personId);
    await writeAudit({ staffId: staff?.id ?? null, privilege: "self", action, subject: { type: "Person", id: personId }, details });
  } catch (e) {
    console.error("[admin] passkey audit write failed", e);
  }
}
const isCloneAlert = (e: unknown) => e instanceof DomainError && (e.details as { cloneSuspected?: boolean } | undefined)?.cloneSuspected === true;
const EXPIRED = () => new DomainError("unauthenticated", "Your sign-in expired. Please sign in again.");

// ---------- sign-in step ----------

/** Pending mode "verify": TOTP or recovery code releases the parked session. */
export async function mfaChallengeAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const pending = await getMfaPending();
    if (!pending || pending.mode !== "verify") throw EXPIRED();
    // Policy: someone who holds a passkey may not fall back to the phishable factors (recovery is an owner-level passkey reset).
    if (pending.passkeyRequired && pending.hasPasskey) throw new DomainError("forbidden", "Your organisation requires a passkey to sign in.");
    await verifyMfa(pending.personId, str(formData, "code"));
  });
  if (!r.ok) return r;
  const out = await afterSecondFactor();
  if (out.kind === "expired") return { ok: false, error: "Your sign-in expired. Please sign in again.", errorKey: "auth.signInExpired" };
  redirect(out.kind === "upgrade" ? MFA_PATH : safeNext(out.next));
}

/** Pending mode "enroll": confirm the first code; returns the one-time recovery codes to display. */
export async function mfaEnrollConfirmAction(_prev: ActionResult<{ recoveryCodes: string[] }> | null, formData: FormData): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  return runAction(async () => {
    const pending = await getMfaPending();
    if (!pending || pending.mode !== "enroll") throw EXPIRED();
    return confirmMfaEnrollment(pending.personId, str(formData, "code"));
  });
}

/** After the recovery codes were shown: release the parked session. */
export async function mfaFinishAction(): Promise<void> {
  const pending = await getMfaPending();
  // Only proceed once MFA is really enabled for this person (enrollment confirmed).
  if (pending && (await mfaStatus(pending.personId)).enabled) {
    const out = await afterSecondFactor();
    if (out.kind === "released") redirect(safeNext(out.next));
  }
  redirect(`${MFA_PATH}`);
}

export async function mfaCancelAction(): Promise<void> {
  await discardMfaChallenge();
  redirect("/signin");
}

// ---------- account security settings (signed-in) ----------
async function personId(): Promise<string> {
  const s = await currentSession();
  if (!s) throw new DomainError("unauthenticated", "Please sign in again.");
  return s.personId;
}

export async function mfaStatusAction(): Promise<ActionResult<MfaStatus>> {
  return runAction(async () => mfaStatus(await personId()));
}

/** Start (or resume) enrollment: returns the otpauth:// URI and manual key. */
export async function mfaBeginAction(): Promise<ActionResult<{ otpauthUri: string; manualKey: string }>> {
  return runAction(async () => {
    const s = await currentSession();
    if (!s) throw new DomainError("unauthenticated", "Please sign in again.");
    return beginMfaEnrollment(s.personId, s.email ?? s.personId);
  });
}

export async function mfaConfirmAction(_prev: ActionResult<{ recoveryCodes: string[] }> | null, formData: FormData): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  return runAction(async () => confirmMfaEnrollment(await personId(), str(formData, "code")));
}

export async function mfaDisableAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  return runAction(async () => disableMfa(await personId(), str(formData, "code")));
}

export async function mfaRegenerateAction(_prev: ActionResult<{ recoveryCodes: string[] }> | null, formData: FormData): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  return runAction(async () => ({ recoveryCodes: await regenerateRecoveryCodes(await personId(), str(formData, "code")) }));
}

// ---------- passkeys: sign-in step (pending-cookie based) ----------
// Wire format between the browser and these actions is the JSON from @simplewebauthn/browser. The server never trusts
// the client for the person: it is whoever the pending cookie says passed the password step.

/** Pending mode "verify": options for navigator.credentials.get. */
export async function passkeyLoginOptionsAction(): Promise<ActionResult<PublicKeyCredentialRequestOptionsJSON>> {
  return runAction(async () => {
    const pending = await getMfaPending();
    if (!pending || pending.mode !== "verify" || !pending.hasPasskey) throw EXPIRED();
    return beginPasskeyAuthentication(appRealm(), pending.personId);
  });
}

/** Verifies the assertion and releases the parked session. Returns where to go (hard navigation so the new cookies apply). */
export async function passkeyLoginVerifyAction(response: AuthenticationResponseJSON): Promise<ActionResult<{ next: string }>> {
  return runAction(async () => {
    const pending = await getMfaPending();
    if (!pending || pending.mode !== "verify") throw EXPIRED();
    try {
      await finishPasskeyAuthentication(appRealm(), pending.personId, response);
    } catch (e) {
      if (isCloneAlert(e)) await auditPasskey(pending.personId, "passkey.clone_suspected", { passkeyId: (e as DomainError & { details: { passkeyId: string } }).details.passkeyId });
      throw e;
    }
    const next = await completeMfaChallenge();
    if (next === null) throw EXPIRED();
    return { next: safeNext(next) };
  });
}

/** Pending mode "passkey_enroll" (policy: forced enrollment after TOTP). */
export async function passkeyEnrollOptionsAction(): Promise<ActionResult<PublicKeyCredentialCreationOptionsJSON>> {
  return runAction(async () => {
    const p = await getMfaPendingAccount();
    if (!p || p.mode !== "passkey_enroll") throw EXPIRED();
    return beginPasskeyRegistration(appRealm(), p.personId, p.account);
  });
}

export async function passkeyEnrollVerifyAction(response: RegistrationResponseJSON, nickname: string): Promise<ActionResult<{ next: string }>> {
  return runAction(async () => {
    const p = await getMfaPendingAccount();
    if (!p || p.mode !== "passkey_enroll") throw EXPIRED();
    const view = await finishPasskeyRegistration(appRealm(), p.personId, response, nickname);
    await auditPasskey(p.personId, "passkey.registered", { passkeyId: view.id, forced: true });
    const next = await completeMfaChallenge();
    if (next === null) throw EXPIRED();
    return { next: safeNext(next) };
  });
}

// ---------- passkeys: account security settings (signed-in) ----------

export interface PasskeySettingsData {
  enabled: boolean;
  required: boolean;
  passkeys: PasskeyView[];
}

export async function passkeyListAction(): Promise<ActionResult<PasskeySettingsData>> {
  return runAction(async () => {
    const id = await personId();
    const realm = appRealm();
    const [policy, passkeys] = await Promise.all([passkeyPolicy(realm, id), listPasskeys(realm, id)]);
    return { enabled: policy.enabled, required: policy.required, passkeys };
  });
}

/** Step-up for settings changes by a person who already has a passkey: options for an assertion. */
export async function passkeyStepUpOptionsAction(): Promise<ActionResult<PublicKeyCredentialRequestOptionsJSON>> {
  return runAction(async () => beginPasskeyAuthentication(appRealm(), await personId()));
}

/** Add a passkey: verifies the step-up proof (code or existing-passkey assertion), then returns creation options. */
export async function passkeyRegisterOptionsAction(proof: PasskeyStepUp): Promise<ActionResult<PublicKeyCredentialCreationOptionsJSON>> {
  return runAction(async () => {
    const s = await currentSession();
    if (!s) throw new DomainError("unauthenticated", "Please sign in again.");
    await verifyPasskeyStepUp(appRealm(), s.personId, proof);
    return beginPasskeyRegistration(appRealm(), s.personId, s.email ?? s.personId);
  });
}

export async function passkeyRegisterVerifyAction(response: RegistrationResponseJSON, nickname: string): Promise<ActionResult<PasskeyView>> {
  return runAction(async () => {
    const id = await personId();
    const view = await finishPasskeyRegistration(appRealm(), id, response, nickname);
    await auditPasskey(id, "passkey.registered", { passkeyId: view.id });
    return view;
  });
}

export async function passkeyRenameAction(passkeyId: string, nickname: string): Promise<ActionResult> {
  return runAction(async () => {
    const id = await personId();
    await renamePasskey(appRealm(), id, passkeyId, nickname);
    await auditPasskey(id, "passkey.renamed", { passkeyId });
  });
}

export async function passkeyRevokeAction(passkeyId: string, proof: PasskeyStepUp): Promise<ActionResult> {
  return runAction(async () => {
    const id = await personId();
    try {
      await revokePasskey(appRealm(), id, passkeyId, proof);
    } catch (e) {
      if (isCloneAlert(e)) await auditPasskey(id, "passkey.clone_suspected", { passkeyId: (e as DomainError & { details: { passkeyId: string } }).details.passkeyId });
      throw e;
    }
    await auditPasskey(id, "passkey.revoked", { passkeyId });
  });
}
