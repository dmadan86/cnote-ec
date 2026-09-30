"use server";
import { cookies } from "next/headers";
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, isLocale, toLocale } from "@/i18n/config";

/** Sets the `cnote_locale` cookie (readable by the client too: the switcher and localised pages also write it). */
export async function writeLocaleCookie(locale: string): Promise<void> {
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", maxAge: LOCALE_COOKIE_MAX_AGE, sameSite: "lax", httpOnly: false, secure: process.env.NODE_ENV === "production" });
}

/**
 * Language switcher: remembers the choice in the cookie and, for a signed-in person, saves it as preferredLanguage so
 * it follows them across devices. Unknown values are ignored; a failed profile save never blocks the switch.
 */
export async function setLocaleAction(locale: string): Promise<{ ok: boolean }> {
  if (!isLocale(locale)) return { ok: false };
  await writeLocaleCookie(locale);
  try {
    const { currentSession } = await import("@cnote/next-kit");
    const s = await currentSession();
    if (s && toLocale(s.preferredLanguage) !== locale) {
      const { updateProfile } = await import("@cnote/identity");
      await updateProfile(s.personId, { preferredLanguage: locale });
    }
  } catch (err) {
    console.error("[i18n] could not persist preferredLanguage", err);
  }
  return { ok: true };
}
