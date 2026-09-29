"use server";
// Server actions for the auth forms. Each sets/clears cookies and redirects on success.
import type { ActionResult } from "./action-result";

export async function signInAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  void formData;
  throw new Error("not implemented");
}
export async function signUpAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  void formData;
  throw new Error("not implemented");
}
export async function forgotPasswordAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  void formData;
  throw new Error("not implemented");
}
export async function resetPasswordAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  void formData;
  throw new Error("not implemented");
}
export async function signOutAction(): Promise<void> {
  throw new Error("not implemented");
}
