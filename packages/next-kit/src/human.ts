import "server-only";
// Bot protection for server actions (Cloudflare Turnstile by default; see @cnote/security human.ts).
import { DomainError } from "@cnote/core";
import { logSecurityEvent, verifyHuman } from "@cnote/security";
import { requestContext } from "./session";

/** Form field the Turnstile widget (`TurnstileWidget`) fills in. hCaptcha/reCAPTCHA use different names; we accept them too. */
const FIELDS = ["cf-turnstile-response", "h-captcha-response", "g-recaptcha-response"] as const;

/**
 * Call at the top of any public, abuse-prone server action (sign-up, OTP request, contact forms):
 *   await verifyHumanOrThrow(formData);
 * Throws DomainError("forbidden") so `runAction` turns it into a form error. No-op-pass with the dev
 * adapter when TURNSTILE_SECRET is unset outside production; fails closed in production.
 */
export async function verifyHumanOrThrow(formData: FormData): Promise<void> {
  let token: string | null = null;
  for (const f of FIELDS) {
    const v = formData.get(f);
    if (typeof v === "string" && v) {
      token = v;
      break;
    }
  }
  await verifyHumanTokenOrThrow(token);
}

/** Same check for actions called with arguments rather than a FormData (e.g. the OTP unlock dialog). */
export async function verifyHumanTokenOrThrow(token: string | null | undefined): Promise<void> {
  const { ip } = await requestContext();
  const r = await verifyHuman(token ?? null, ip);
  if (!r.ok) {
    logSecurityEvent("human.rejected", { reason: r.reason, ip });
    throw new DomainError("forbidden", "We couldn't verify that you're human. Please retry the check and submit again.");
  }
}
