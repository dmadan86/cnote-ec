"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { isLocale, LOCALE_COOKIE } from "./config";

const YEAR = 60 * 60 * 24 * 365;

/**
 * Language switcher: remember the choice for a year; unknown values are ignored.
 * Public on purpose (no requireSeller): the switcher is on landing/auth/onboarding so the language can be chosen before
 * sign-up (ADR-004). It only sets the locale cookie; no account data is read or written. See docs/guides/i18n.md.
 */
export async function setLocaleAction(fd: FormData): Promise<void> {
  const v = fd.get("locale");
  if (!isLocale(v)) return;
  (await cookies()).set(LOCALE_COOKIE, v, { path: "/", maxAge: YEAR, sameSite: "lax", httpOnly: true, secure: process.env.NODE_ENV === "production" });
  revalidatePath("/", "layout");
}
