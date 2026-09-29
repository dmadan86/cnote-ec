"use server";
// Server actions for the auth forms. Each sets/clears cookies and redirects on success.
// Only async functions may be exported from a "use server" module.
import { REFRESH_COOKIE, requestPasswordReset, resetPassword, signInWithPassword, signOut, signUpWithPassword } from "@cnote/identity";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { runAction, type ActionResult } from "./action-result";
import { clearAuthCookies, safeNext, setAuthCookies } from "./cookies";
import { requestContext } from "./session";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

export async function signInAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const tokens = await signInWithPassword({ email: str(formData, "email"), password: str(formData, "password") }, await requestContext());
    setAuthCookies(await cookies(), tokens);
  });
  if (!r.ok) return r;
  redirect(safeNext(str(formData, "next")));
}

export async function signUpAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  // "matching" consent is required to use the marketplace (leads are matched to sellers); marketing is optional (ADR-010).
  if (formData.get("consent_matching") !== "on") {
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: { consent_matching: "Consent to enquiry matching is needed to create an account." } };
  }
  const r = await runAction(async () => {
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
  const r = await runAction(() => resetPassword(str(formData, "token"), str(formData, "password")));
  if (!r.ok) return r;
  redirect(safeNext(str(formData, "redirectTo"), "/signin"));
}

export async function signOutAction(): Promise<void> {
  const store = await cookies();
  const rt = store.get(REFRESH_COOKIE)?.value;
  if (rt) await signOut(rt);
  clearAuthCookies(store);
  redirect("/");
}
