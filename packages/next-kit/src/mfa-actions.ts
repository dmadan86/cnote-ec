"use server";
// Server actions for the MFA step of sign-in (pending-cookie based) and for the account security settings
// (session based). Only async functions may be exported from a "use server" module.
import { beginMfaEnrollment, confirmMfaEnrollment, disableMfa, mfaStatus, regenerateRecoveryCodes, verifyMfa, type MfaStatus } from "@cnote/identity";
import { redirect } from "next/navigation";
import { runAction, type ActionResult } from "./action-result";
import { DomainError } from "@cnote/core";
import { completeMfaChallenge, discardMfaChallenge, getMfaPending, MFA_PATH } from "./mfa-flow";
import { safeNext } from "./cookies";
import { currentSession } from "./session";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim().slice(0, 64) : "";
};
const EXPIRED = () => new DomainError("unauthenticated", "Your sign-in expired. Please sign in again.");

// ---------- sign-in step ----------

/** Pending mode "verify": TOTP or recovery code releases the parked session. */
export async function mfaChallengeAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const pending = await getMfaPending();
    if (!pending || pending.mode !== "verify") throw EXPIRED();
    await verifyMfa(pending.personId, str(formData, "code"));
  });
  if (!r.ok) return r;
  const next = await completeMfaChallenge();
  if (next === null) return { ok: false, error: "Your sign-in expired. Please sign in again.", errorKey: "auth.signInExpired" };
  redirect(safeNext(next));
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
    const next = await completeMfaChallenge();
    if (next !== null) redirect(safeNext(next));
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
