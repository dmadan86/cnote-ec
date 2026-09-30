import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { DomainError, redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { enforceLimit } from "./limits";
import { resolveOtpSender } from "./phone-login";
import { jwtKey } from "./tokens";

const OTP_TTL = 10 * 60;
const MAX_ATTEMPTS = 5;
const otpKey = (personId: string) => `otp:${personId}`;

/** E.164; bare 10-digit Indian mobiles get +91. */
export function normalisePhone(raw: string): string {
  const s = raw.replace(/[\s\-().]/g, "");
  const phone = /^[6-9]\d{9}$/.test(s) ? `+91${s}` : s.startsWith("00") ? `+${s.slice(2)}` : s;
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new DomainError("validation", "Enter a valid phone number with country code.");
  return phone;
}

const digest = (personId: string, phone: string, code: string) =>
  createHmac("sha256", jwtKey()).update(`${personId}:${phone}:${code}`).digest("hex");

/** T0 verification (ADR-003). 3 per 10 min per phone, 10/day per person. */
export async function requestPhoneOtp(personId: string, phoneInput: string): Promise<{ sent: true; devCode?: string }> {
  const phone = normalisePhone(phoneInput);
  await enforceLimit(`otp:phone:${phone}`, 3, 600, "Too many codes requested for this number. Try again in a few minutes.");
  await enforceLimit(`otp:person:${personId}`, 10, 86400, "Daily code limit reached. Try again tomorrow.");
  const taken = await prisma.person.findFirst({ where: { phone, id: { not: personId } }, select: { id: true } });
  if (taken) throw new DomainError("conflict", "This phone number is already linked to another account.");

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const key = otpKey(personId);
  await redis.multi().hset(key, { phone, hash: digest(personId, phone, code), attempts: 0 }).expire(key, OTP_TTL).exec();

  // Same delivery path as phone sign-in (OTP_SENDER: console | msg91 | whatsapp_cloud | whatsapp_then_sms).
  await (await resolveOtpSender()).send({ to: phone, code, channel: "sms", ttlMinutes: OTP_TTL / 60 });
  return process.env.OTP_DEV_ECHO === "true" ? { sent: true, devCode: code } : { sent: true };
}

export async function verifyPhoneOtp(personId: string, phoneInput: string, code: string): Promise<{ verified: boolean }> {
  const phone = normalisePhone(phoneInput);
  const key = otpKey(personId);
  const rec = await redis.hgetall(key);
  if (!rec.hash || rec.phone !== phone) return { verified: false };
  const attempts = await redis.hincrby(key, "attempts", 1);
  if (attempts > MAX_ATTEMPTS) {
    await redis.del(key);
    throw new DomainError("rate_limited", "Too many incorrect attempts. Request a new code.");
  }
  const a = Buffer.from(digest(personId, phone, code.trim()));
  const b = Buffer.from(rec.hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { verified: false };
  await redis.del(key);

  await prisma.$transaction(async (tx) => {
    try {
      await tx.person.update({ where: { id: personId }, data: { phone, phoneVerifiedAt: new Date() } });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new DomainError("conflict", "This phone number is already linked to another account.");
      throw err;
    }
    const memberships = await tx.businessMember.findMany({ where: { personId }, select: { businessId: true } });
    for (const m of memberships) {
      await tx.verificationRecord.create({
        data: { businessId: m.businessId, tier: 0, kind: "phone_otp", status: "passed", provider: "otp", details: { phoneLast4: phone.slice(-4) } },
      });
    }
  });
  return { verified: true };
}
