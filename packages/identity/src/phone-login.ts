// Passwordless phone-OTP sign-in / sign-up (lead-gen unlock, ADR-003 T0). Realm-bound like every other
// sign-in: the AuthContext carries the realm and admission guard, issueTokens enforces them.
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { DomainError, emit, redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { devEchoEnabled } from "./dev-echo";
import { enforceLimit } from "./limits";
import { normalisePhone } from "./otp";
import { issueTokens } from "./sessions";
import { jwtKey, sha256 } from "./tokens";
import type { AuthContext, AuthTokens, ConsentPurpose } from "./types";

export type OtpChannel = "sms" | "whatsapp";

/** Port for delivering a login OTP. Providers implement this; the console adapter is the dev default. */
export interface OtpSender {
  send(msg: { to: string; code: string; channel: OtpChannel; ttlMinutes: number }): Promise<void>;
}

/** Dev adapter: writes the message to the server log. Never used when a real sender is registered. */
export const consoleOtpSender: OtpSender = {
  async send({ to, code, channel, ttlMinutes }) {
    console.info(`[otp:${channel}] to=${to} code=${code} (valid ${ttlMinutes} min)`);
  },
};

/*
 * Production adapters (not implemented yet; register with setOtpSender at worker/web bootstrap):
 *  - MSG91  SMS: POST https://control.msg91.com/api/v5/otp?template_id=<DLT-mapped flow>&mobile=91XXXXXXXXXX&authkey=...&otp=<code>
 *           (TRAI DLT: entity, header and template must be registered; the template id is mandatory).
 *           WhatsApp: MSG91 WhatsApp API with an approved AUTHENTICATION template.
 *  - Gupshup: SMS enterprise API (userid/password, `dltTemplateId`), WhatsApp via template message API.
 *  - Twilio: Verify or Messages API; SMS to India needs DLT registration too; WhatsApp via the "whatsapp:" prefix.
 * WhatsApp authentication templates carry exactly one variable (the code); no promotional text or links.
 */
export function unconfiguredOtpSender(provider: "msg91" | "gupshup" | "twilio"): OtpSender {
  return {
    async send() {
      throw new Error(`OTP provider "${provider}" is not implemented yet.`);
    },
  };
}

// Resolved lazily from OTP_SENDER on first use (see otp-senders.ts), so every process and every Next.js bundle
// gets the configured provider without bootstrap wiring. setOtpSender overrides it (tests, composition roots).
let sender: OtpSender | undefined;
/** The sender in use, or the console adapter if nothing has resolved yet (sync, for diagnostics). */
export const getOtpSender = (): OtpSender => sender ?? consoleOtpSender;
export const setOtpSender = (s: OtpSender | undefined) => void (sender = s);
export async function resolveOtpSender(): Promise<OtpSender> {
  // Dynamic import: otp-senders imports this module, so a static import would be circular.
  return (sender ??= (await import("./otp-senders")).otpSenderFromEnv());
}

const OTP_TTL = 10 * 60;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN = 30;

/** sha256(E.164): the only form of the phone number lead-gen stores before verification (DPDP minimisation). */
export const hashPhone = (phone: string) => sha256(normalisePhone(phone));

const key = (phone: string) => `lotp:${sha256(phone)}`;
const digest = (phone: string, code: string) => createHmac("sha256", jwtKey()).update(`login:${phone}:${code}`).digest("hex");

export type LoginContext = AuthContext & { visitorId?: string | null };

/** Back-office accounts sign in with password/Google + MFA only; an SMS code must never mint an admin session. */
const refuseAdminRealm = (ctx: Pick<AuthContext, "realm">) => {
  if (ctx.realm === "admin") throw new DomainError("forbidden", "Phone sign-in is not available here.");
};

export async function requestLoginOtp(
  phoneInput: string,
  ctx: LoginContext,
  opts: { channel?: OtpChannel } = {},
): Promise<{ sent: true; phone: string; phoneHash: string; channel: OtpChannel; resendAfterSeconds: number; devCode?: string }> {
  refuseAdminRealm(ctx);
  const phone = normalisePhone(phoneInput);
  const channel: OtpChannel = opts.channel === "whatsapp" ? "whatsapp" : "sms";
  await enforceLimit(`lotp:cool:${sha256(phone)}`, 1, RESEND_COOLDOWN, "Please wait a few seconds before requesting another code.");
  await enforceLimit(`lotp:phone:${sha256(phone)}`, 3, 600, "Too many codes requested for this number. Try again in a few minutes.");
  await enforceLimit(`lotp:phone-day:${sha256(phone)}`, 10, 86400, "Daily code limit reached for this number. Try again tomorrow.");
  await enforceLimit(`lotp:ip:${ctx.ip ?? "unknown"}`, 20, 3600, "Too many codes requested from this network. Try again later.");
  if (ctx.visitorId) await enforceLimit(`lotp:vid:${ctx.visitorId}`, 10, 86400, "Too many codes requested. Try again tomorrow.");

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const k = key(phone);
  await redis.multi().hset(k, { hash: digest(phone, code), attempts: 0 }).expire(k, OTP_TTL).exec();
  await (await resolveOtpSender()).send({ to: phone, code, channel, ttlMinutes: OTP_TTL / 60 });
  const base = { sent: true as const, phone, phoneHash: sha256(phone), channel, resendAfterSeconds: RESEND_COOLDOWN };
  return devEchoEnabled() ? { ...base, devCode: code } : base;
}

/**
 * Verifies the code, finds or creates the Person for this phone (phoneVerifiedAt set), records purpose-scoped
 * consents (append-only ledger, ADR-010) and issues realm-bound tokens. `isNew` tells whether the person was created.
 */
export async function verifyLoginOtp(
  phoneInput: string,
  codeInput: string,
  ctx: LoginContext,
  opts: { consents?: Partial<Record<ConsentPurpose, boolean>> } = {},
): Promise<AuthTokens> {
  refuseAdminRealm(ctx);
  const phone = normalisePhone(phoneInput);
  await enforceLimit(`lotp:verify-ip:${ctx.ip ?? "unknown"}`, 30, 600, "Too many attempts. Try again later.");
  const bad = () => new DomainError("validation", "That code is incorrect or has expired.");
  const k = key(phone);
  const rec = await redis.hgetall(k);
  if (!rec.hash) throw bad();
  const attempts = await redis.hincrby(k, "attempts", 1);
  if (attempts > MAX_ATTEMPTS) {
    await redis.del(k);
    throw new DomainError("rate_limited", "Too many incorrect attempts. Request a new code.");
  }
  const a = Buffer.from(digest(phone, codeInput.trim()));
  const b = Buffer.from(rec.hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw bad();
  await redis.del(k);

  const consents = Object.entries(opts.consents ?? {}) as [ConsentPurpose, boolean][];
  const writeConsents = async (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], personId: string) => {
    for (const [purpose, granted] of consents) {
      await tx.consent.create({ data: { personId, purpose, granted, source: "web_unlock" } });
      await emit(tx, "ConsentChanged", { type: "Person", id: personId }, { personId, purpose, granted });
    }
  };

  const attempt = () =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.person.findUnique({ where: { phone }, select: { id: true, erasedAt: true, phoneVerifiedAt: true } });
      if (existing) {
        if (existing.erasedAt) throw new DomainError("unauthenticated", "This account is no longer available.");
        if (!existing.phoneVerifiedAt) await tx.person.update({ where: { id: existing.id }, data: { phoneVerifiedAt: new Date() } });
        await writeConsents(tx, existing.id);
        return { id: existing.id, isNew: false };
      }
      const p = await tx.person.create({ data: { phone, phoneVerifiedAt: new Date() }, select: { id: true } });
      await writeConsents(tx, p.id);
      await emit(tx, "PersonRegistered", { type: "Person", id: p.id }, { personId: p.id, phone });
      return { id: p.id, isNew: true };
    });
  let person: { id: string; isNew: boolean };
  try {
    person = await attempt();
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") throw err;
    person = await attempt(); // lost a create race for the same phone: now it exists
  }
  return issueTokens(person.id, ctx, person.isNew);
}
