"use server";
import { DomainError } from "@cnote/core";
import {
  createBusiness, erasePerson, getConsents, requestPhoneOtp, setConsent, signOutAllSessions, updateProfile, verifyPhoneOtp,
  CONSENT_PURPOSES,
} from "@cnote/identity";
import { clearAuthCookies, requireSession, runAction, safeNext, type ActionResult } from "@cnote/next-kit";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

export async function updateProfileAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const s = await requireSession("/account");
  const r = await runAction(() => updateProfile(s.personId, { name: str(fd, "name"), preferredLanguage: str(fd, "preferredLanguage") }));
  if (r.ok) revalidatePath("/account");
  return r;
}

export async function requestOtpAction(_prev: ActionResult<{ phone: string; devCode?: string }> | null, fd: FormData): Promise<ActionResult<{ phone: string; devCode?: string }>> {
  const s = await requireSession("/account");
  return runAction(async () => {
    const phone = str(fd, "phone");
    const res = await requestPhoneOtp(s.personId, phone);
    return { phone, devCode: res.devCode };
  });
}

export async function verifyOtpAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const s = await requireSession("/account");
  const r = await runAction(async () => {
    const { verified } = await verifyPhoneOtp(s.personId, str(fd, "phone"), str(fd, "code"));
    if (!verified) throw new DomainError("validation", "That code is incorrect or has expired.");
  });
  if (r.ok) revalidatePath("/account");
  return r;
}

export async function saveConsentsAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const s = await requireSession("/account");
  const r = await runAction(async () => {
    const current = await getConsents(s.personId);
    for (const purpose of CONSENT_PURPOSES) {
      const wanted = fd.get(`consent_${purpose}`) === "on";
      if (wanted !== current[purpose]) await setConsent(s.personId, purpose, wanted, "web");
    }
  });
  if (r.ok) revalidatePath("/account");
  return r;
}

export async function signOutEverywhereAction(): Promise<void> {
  const s = await requireSession("/account");
  await signOutAllSessions(s.personId);
  clearAuthCookies(await cookies());
  redirect("/signin");
}

export async function deleteAccountAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const s = await requireSession("/account");
  if (str(fd, "confirm").trim() !== "DELETE") {
    return { ok: false, error: "Type DELETE to confirm.", fieldErrors: { confirm: "Type DELETE to confirm." } };
  }
  const r = await runAction(() => erasePerson(s.personId));
  if (!r.ok) return r;
  clearAuthCookies(await cookies());
  redirect("/");
}

const onboardingSchema = z.object({
  name: z.string().trim().min(2, "Enter your business name."),
  city: z.string().trim().min(1, "Enter your city."),
  state: z.string().trim().min(1, "Select your state."),
  pincode: z.string().trim().regex(/^[1-9]\d{5}$/, "Enter a valid 6-digit pincode."),
});

/** Buyer business (buyer and seller are roles on one Business, ADR-007). Sellers onboard in the seller app. */
export async function createBuyerBusinessAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const s = await requireSession("/onboarding");
  if (!s.business) {
    const r = await runAction(async () => {
      const d = onboardingSchema.parse({ name: str(fd, "name"), city: str(fd, "city"), state: str(fd, "state"), pincode: str(fd, "pincode") });
      await createBusiness(s.personId, { ...d, isSeller: false });
    });
    if (!r.ok) return r;
  }
  redirect(safeNext(str(fd, "next")));
}
