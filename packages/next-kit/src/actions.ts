"use server";
// Server actions for the auth forms. Each sets/clears cookies and redirects on success.
// Only async functions may be exported from a "use server" module.
import { DomainError } from "@cnote/core";
import { passwordProblem, requestPasswordReset, resetPassword, signInWithPassword, signOut, signUpWithPassword } from "@cnote/identity";
import { logSecurityEvent } from "@cnote/security";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { runAction, type ActionResult } from "./action-result";
import { clearAuthCookies, safeNext, setAuthCookies } from "./cookies";
import { appRealm, realmCookies } from "./realm";
import { verifyHumanOrThrow } from "./human";
import { beginMfaChallenge } from "./mfa-flow";
import { requestContext } from "./session";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

export async function signInAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const ctx = await requestContext();
    let tokens;
    try {
      tokens = await signInWithPassword({ email: str(formData, "email"), password: str(formData, "password") }, ctx);
    } catch (err) {
      if (err instanceof DomainError && err.code === "unauthenticated") logSecurityEvent("auth.signin_failed", { realm: appRealm(), ip: ctx.ip });
      throw err;
    }
    const store = await cookies();
    // Second factor due (always for admin, opt-in elsewhere): park the session behind the MFA step instead of issuing it.
    const challenge = await beginMfaChallenge(tokens, str(formData, "next"));
    if (challenge) {
      store.set(challenge.cookie);
      return challenge.path;
    }
    setAuthCookies(store, tokens);
    return null;
  });
  if (!r.ok) return r;
  redirect(r.data ?? safeNext(str(formData, "next")));
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function signUpAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  // "matching" consent is required to use the marketplace (leads are matched to sellers); marketing is optional (ADR-010).
  // Every field problem is reported at once, on its own field: the identity schemas validate bare strings, so their ZodErrors
  // carry no field name and would otherwise surface as a form with no visible error (WCAG 3.3.1).
  const fieldErrors: Record<string, string> = {};
  if (!EMAIL_SHAPE.test(str(formData, "email").trim())) fieldErrors.email = "Enter a valid email address.";
  const pwProblem = passwordProblem(str(formData, "password"));
  if (pwProblem) fieldErrors.password = pwProblem;
  if (formData.get("consent_matching") !== "on") fieldErrors.consent_matching = "Consent to enquiry matching is needed to create an account.";
  if (Object.keys(fieldErrors).length) return { ok: false, error: "Please fix the highlighted fields.", fieldErrors };
  const r = await runAction(async () => {
    await verifyHumanOrThrow(formData); // bot protection (Turnstile) before any account work
    const tokens = await signUpWithPassword(
      {
        email: str(formData, "email"),
        password: str(formData, "password"),
        name: str(formData, "name"),
        consents: { matching: true, marketing: formData.get("consent_marketing") === "on" },
      },
      await requestContext(),
    );
    setAuthCookies(await cookies(), tokens);
  });
  if (!r.ok) return r;
  redirect(safeNext(str(formData, "next")));
}

export async function forgotPasswordAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  // Same response whether or not the account exists (no enumeration).
  return runAction(async () => {
    await requestPasswordReset(str(formData, "email"), await requestContext());
  });
}

export async function resetPasswordAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const pwProblem = passwordProblem(str(formData, "password"));
  if (pwProblem) return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: { password: pwProblem } };
  const r = await runAction(() => resetPassword(str(formData, "token"), str(formData, "password")));
  if (!r.ok) return r;
  redirect(safeNext(str(formData, "redirectTo"), "/signin"));
}

export async function signOutAction(): Promise<void> {
  const store = await cookies();
  const rt = store.get(realmCookies().refresh)?.value;
  if (rt) await signOut(rt, appRealm());
  clearAuthCookies(store);
  redirect("/");
}
