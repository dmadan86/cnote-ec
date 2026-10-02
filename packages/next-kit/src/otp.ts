"use server";
// Server actions for the lead-gen unlock dialog (phone OTP -> realm session -> completed action).
// Only async functions may be exported from a "use server" module.
import { requestLoginOtp, requestPhoneOtp, verifyLoginOtp, verifyPhoneOtp, type OtpChannel } from "@cnote/identity";
import { completeUnlock, markOtpSent, markVerified, startCapture, type StartCaptureInput, type UnlockDetails, type UnlockResult } from "@cnote/leadgen";
import { DomainError } from "@cnote/core";
import { cookies } from "next/headers";
import { runAction, type ActionResult } from "./action-result";
import { setAuthCookies } from "./cookies";
import { verifyHumanTokenOrThrow } from "./human";
import { beginMfaChallenge } from "./mfa-flow";
import { appRealm } from "./realm";
import { currentSession, requestContext } from "./session";

export type StartUnlockResult =
  | { signedIn: true; captureId: string; result: UnlockResult }
  | { signedIn: false; captureId: string };
export type SendOtpResult = { resendAfterSeconds: number; channel: OtpChannel; devCode?: string };
/** `mfaRequired`: the person has a second factor, so the session is parked behind the MFA step and nothing is unlocked yet. */
export type VerifyOtpResult = { result: UnlockResult; isNew: boolean } | { mfaRequired: true; path: string };

/** Phone OTP is a visitor/buyer/seller sign-in only. Back-office accounts must use password/Google + MFA, never an SMS code. */
function refuseAdminRealm() {
  if (appRealm() === "admin") throw new DomainError("forbidden", "Phone sign-in is not available here.");
}

/**
 * Opens a capture. Signed-in buyers with a verified phone skip the dialog entirely: the unlock completes here.
 * `humanToken` is the bot-check token (Turnstile, wired by @cnote/security); accepted and passed through so
 * callers need no change when verification is enabled.
 */
export async function startUnlock(input: StartCaptureInput, details?: UnlockDetails, humanToken?: string): Promise<ActionResult<StartUnlockResult>> {
  void humanToken;
  return runAction(async () => {
    const s = await currentSession();
    if (s?.phoneVerified) {
      const { captureId } = await startCapture(input, s.personId);
      await markVerified(captureId, s.personId, false);
      return { signedIn: true as const, captureId, result: await completeUnlock(s.personId, captureId, details) };
    }
    const { captureId } = await startCapture(input, null);
    return { signedIn: false as const, captureId };
  });
}

export async function sendOtp(captureId: string, phone: string, channel: OtpChannel, followUpConsent = false, humanToken?: string, visitorId?: string): Promise<ActionResult<SendOtpResult>> {
  return runAction(async () => {
    refuseAdminRealm();
    // OTP sends cost money and are the favourite target of SMS-pumping bots: require the human check first.
    await verifyHumanTokenOrThrow(humanToken);
    const ctx = { ...(await requestContext()), visitorId: visitorId ?? null };
    const s = await currentSession();
    if (s && !s.phoneVerified) {
      // Signed-in account without a verified phone: verify the phone on that account instead of switching accounts.
      const r = await requestPhoneOtp(s.personId, phone);
      await markOtpSent(captureId, phone, followUpConsent);
      return { resendAfterSeconds: 30, channel: "sms" as const, ...(r.devCode ? { devCode: r.devCode } : {}) };
    }
    const r = await requestLoginOtp(phone, ctx, { channel });
    await markOtpSent(captureId, phone, followUpConsent);
    return { resendAfterSeconds: r.resendAfterSeconds, channel: r.channel, ...(r.devCode ? { devCode: r.devCode } : {}) };
  });
}

/**
 * Verifies the code, sets this realm's auth cookies (new or existing person), then completes the unlock.
 * `consentMatching` must be true: sharing the requirement with matched sellers is the purpose of the action (ADR-010).
 */
export async function verifyOtp(captureId: string, phone: string, code: string, consents: { matching: boolean; marketing?: boolean }, details?: UnlockDetails, visitorId?: string): Promise<ActionResult<VerifyOtpResult>> {
  if (!consents.matching) {
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: { consent_matching: "Consent to share your requirement with matched suppliers is needed to continue." } };
  }
  return runAction(async () => {
    refuseAdminRealm();
    const s = await currentSession();
    if (s && !s.phoneVerified) {
      const v = await verifyPhoneOtp(s.personId, phone, code);
      if (!v.verified) throw new DomainError("validation", "That code is incorrect or has expired.");
      await markVerified(captureId, s.personId, false, phone);
      return { result: await completeUnlock(s.personId, captureId, details), isNew: false };
    }
    const tokens = await verifyLoginOtp(phone, code, { ...(await requestContext()), visitorId: visitorId ?? null }, { consents: { matching: true, marketing: consents.marketing === true } });
    const store = await cookies();
    // Same second-factor gate as password and Google sign-in: a person with MFA enabled does not get a session (or an
    // unlock) from an SMS code alone. The tokens are parked behind the MFA step; the unlock completes after it.
    const challenge = await beginMfaChallenge(tokens, null);
    if (challenge) {
      store.set(challenge.cookie);
      return { mfaRequired: true as const, path: challenge.path };
    }
    setAuthCookies(store, tokens);
    await markVerified(captureId, tokens.personId, tokens.isNew, phone);
    return { result: await completeUnlock(tokens.personId, captureId, details), isNew: tokens.isNew };
  });
}
