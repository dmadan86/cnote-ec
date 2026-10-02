"use server";
import { DomainError } from "@cnote/core";
import {
  createBusiness, erasePersonWithStepUp, getConsents, requestPhoneOtp, setConsent, signOutAllSessions, updateProfile, verifyPhoneOtp,
  CONSENT_PURPOSES, COOKIE_CONSENT_PURPOSES,
} from "@cnote/identity";
import { clearAuthCookies, requireSession, safeNext, type ActionResult } from "@cnote/next-kit";
import { runLocalized } from "@/i18n/errors";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { toLocale } from "@/i18n/config";
import { writeLocaleCookie } from "@/lib/locale-actions";
import { getRequestLocale } from "@/lib/request-locale";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

export async function updateProfileAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const s = await requireSession("/account");
  const r = await runLocalized(() => updateProfile(s.personId, { name: str(fd, "name"), preferredLanguage: str(fd, "preferredLanguage") }));
  if (r.ok) {
    // The profile language also drives the unprefixed routes: keep the cookie (which wins over preferredLanguage) in step.
    const chosen = toLocale(str(fd, "preferredLanguage"));
    if (chosen) await writeLocaleCookie(chosen);
    revalidatePath("/account");
  }
  return r;
}

export async function requestOtpAction(_prev: ActionResult<{ phone: string; devCode?: string }> | null, fd: FormData): Promise<ActionResult<{ phone: string; devCode?: string }>> {
  const s = await requireSession("/account");
  return runLocalized(async () => {
    const phone = str(fd, "phone");
    const res = await requestPhoneOtp(s.personId, phone);
    return { phone, devCode: res.devCode };
  });
}

export async function verifyOtpAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const s = await requireSession("/account");
  const r = await runLocalized(async () => {
    const { verified } = await verifyPhoneOtp(s.personId, str(fd, "phone"), str(fd, "code"));
    if (!verified) throw new DomainError("validation", "That code is incorrect or has expired.");
  });
  if (r.ok) revalidatePath("/account");
  return r;
}

export async function saveConsentsAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const s = await requireSession("/account");
  const r = await runLocalized(async () => {
    const current = await getConsents(s.personId);
    for (const purpose of CONSENT_PURPOSES) {
      // Cookie-banner purposes are not on this form (they follow the banner via /api/consent): skip them or a save would withdraw them.
      if ((COOKIE_CONSENT_PURPOSES as readonly string[]).includes(purpose)) continue;
      const wanted = fd.get(`consent_${purpose}`) === "on";
      if (wanted !== current[purpose]) await setConsent(s.personId, purpose, wanted, "web");
    }
  });
  if (r.ok) revalidatePath("/account");
  return r;
}

export async function signOutEverywhereAction(): Promise<void> {
  const s = await requireSession("/account");
  await signOutAllSessions(s.personId, "web");
  clearAuthCookies(await cookies());
  redirect("/signin");
}

export async function deleteAccountAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const s = await requireSession("/account");
  if (str(fd, "confirm").trim() !== "DELETE") {
    const msg = (await getTranslations({ locale: await getRequestLocale(), namespace: "actions" }))("typeDelete");
    return { ok: false, error: msg, fieldErrors: { confirm: msg } };
  }
  // Irreversible: re-verify the owner right now (password, MFA code, or an OTP verified in the last 5 minutes; audit M10).
  const r = await runLocalized(() => erasePersonWithStepUp(s.personId, { password: str(fd, "password"), mfaCode: str(fd, "mfaCode") }));
  if (!r.ok) return r;
  clearAuthCookies(await cookies());
  redirect("/");
}

/** Validation messages come from the `actions` catalogue in the buyer's language (zod's `error` callbacks take a key). */
const onboardingSchema = (t: (k: string) => string) =>
  z.object({
    name: z.string().trim().min(2, t("onbName")),
    city: z.string().trim().min(1, t("onbCity")),
    state: z.string().trim().min(1, t("onbState")),
    pincode: z.string().trim().regex(/^[1-9]\d{5}$/, t("onbPincode")),
  });

/** Buyer business (buyer and seller are roles on one Business, ADR-007). Sellers onboard in the seller app. */
export async function createBuyerBusinessAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const s = await requireSession("/onboarding");
  if (!s.business) {
    const r = await runLocalized(async () => {
      const t = await getTranslations({ locale: await getRequestLocale(), namespace: "actions" });
      const d = onboardingSchema(t).parse({ name: str(fd, "name"), city: str(fd, "city"), state: str(fd, "state"), pincode: str(fd, "pincode") });
      await createBusiness(s.personId, { ...d, isSeller: false });
    });
    if (!r.ok) return r;
  }
  redirect(safeNext(str(fd, "next")));
}
