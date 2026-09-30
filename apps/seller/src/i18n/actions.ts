"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { isLocale, LOCALE_COOKIE } from "./config";

const YEAR = 60 * 60 * 24 * 365;

/** Language switcher: remember the choice for a year; unknown values are ignored. */
export async function setLocaleAction(fd: FormData): Promise<void> {
  const v = fd.get("locale");
  if (!isLocale(v)) return;
  (await cookies()).set(LOCALE_COOKIE, v, { path: "/", maxAge: YEAR, sameSite: "lax", httpOnly: true, secure: process.env.NODE_ENV === "production" });
  revalidatePath("/", "layout");
}
