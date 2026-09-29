"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireSession, type ActionResult } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { ONB, readOnb, writeOnb } from "@/lib/cookies";
import { LANGUAGES } from "@/lib/constants";
import { str, strs } from "@/lib/form-data";
import { logEvent } from "@/lib/metrics";
import { run } from "@/lib/run";
import { billing, identity } from "@/lib/services";

/** Step 1 (ADR-003 fast path): the smallest thing that creates a seller business. */
export async function createBusinessAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const session = await requireSession("/onboarding");
  if (session.business) redirect("/onboarding");
  const result = await run(async () => {
    const input = z
      .object({
        name: z.string().min(2, "Enter your business name.").max(120),
        city: z.string().min(2, "Enter your city.").max(80),
        state: z.string().min(2, "Choose your state."),
        pincode: z.string().regex(/^[1-9]\d{5}$/, "Pincode is 6 digits."),
        languages: z.array(z.enum(LANGUAGES.map((l) => l.code) as [string, ...string[]])).min(1, "Pick at least one language."),
      })
      .parse({ name: str(fd, "name"), city: str(fd, "city"), state: str(fd, "state"), pincode: str(fd, "pincode"), languages: strs(fd, "languages") });
    const { businessId } = await identity.createBusiness(session.personId, { ...input, isSeller: true });
    await writeOnb(ONB.startedAt, String(Date.now()));
    logEvent("seller.onboarding_business_created", { personId: session.personId, businessId });
    return undefined;
  });
  if (result.ok) redirect("/onboarding");
  return result;
}

const phoneSchema = z
  .string()
  .transform((v) => v.replace(/[\s-]/g, "").replace(/^(\+91|91|0)(?=\d{10}$)/, ""))
  .refine((v) => /^[6-9]\d{9}$/.test(v), "Enter a 10-digit Indian mobile number.")
  .transform((v) => `+91${v}`);

export type OtpSent = ActionResult<{ phone: string; devCode?: string }>;

export async function requestOtpAction(_prev: OtpSent | null, fd: FormData): Promise<OtpSent> {
  const session = await requireSession("/onboarding");
  return run(async () => {
    const phone = phoneSchema.parse(str(fd, "phone"));
    const res = await identity.requestPhoneOtp(session.personId, phone);
    logEvent("seller.onboarding_otp_requested", { personId: session.personId });
    return { phone, devCode: res.devCode };
  });
}

export async function verifyOtpAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const session = await requireSession("/onboarding");
  const result = await run(async () => {
    const phone = phoneSchema.parse(str(fd, "phone"));
    const code = z.string().regex(/^\d{4,8}$/, "Enter the code from the SMS.").parse(str(fd, "code"));
    const res = await identity.verifyPhoneOtp(session.personId, phone, code);
    if (!res.verified) throw new z.ZodError([{ code: "custom", path: ["code"], message: "That code did not match. Check it and try again.", input: code }]);
    logEvent("seller.onboarding_phone_verified", { personId: session.personId });
    return undefined;
  });
  if (result.ok) redirect("/onboarding");
  return result;
}

/** "I don't have GST yet" / "Add a listing later": the seller stays at their current tier and can return any time. */
export async function skipStepAction(fd: FormData): Promise<void> {
  await requireSeller("/onboarding");
  const step = str(fd, "step");
  if (step === "gst") await writeOnb(ONB.skipGst, "1");
  else if (step === "listing") await writeOnb(ONB.skipListing, "1");
  redirect("/onboarding");
}

/** Step 5: plan (free by default, no auto-upgrade) + purpose-scoped consents (ADR-005, ADR-010). */
export async function finishOnboardingAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const session = await requireSeller("/onboarding");
  const result = await run(async () => {
    for (const purpose of ["matching", "counterparty_sharing", "marketing"] as const) {
      await identity.setConsent(session.personId, purpose, fd.get(purpose) === "on", "seller_onboarding");
    }
    const planCode = str(fd, "planCode");
    if (planCode) {
      const plans = await billing.listPlans();
      const plan = plans.find((p) => p.code === planCode);
      if (!plan) throw new z.ZodError([{ code: "custom", path: ["planCode"], message: "Choose one of the plans shown.", input: planCode }]);
      if (plan.monthlyPricePaise > 0) await billing.subscribe(session.business.id, plan.code);
    }
    await writeOnb(ONB.done, "1");
    const t0 = Number(await readOnb(ONB.startedAt));
    logEvent("seller.onboarding_completed", { businessId: session.business.id, totalMs: Number.isFinite(t0) && t0 > 0 ? Date.now() - t0 : null, planCode: planCode || null });
    return undefined;
  });
  if (result.ok) redirect("/onboarding/done");
  return result;
}
