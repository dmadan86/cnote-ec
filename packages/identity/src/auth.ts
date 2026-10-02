import { DomainError, emit, redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { z } from "zod";
import { backoffRemaining, clearFailures, knownIp, recordFailure, throwBackedOff } from "./auth-guard";
import { enforceLimit } from "./limits";
import { enqueueAccountMail } from "./mail-queue";
import { dummyVerify, hashPassword, normaliseEmail, passwordSchema, verifyPassword } from "./password";
import { REALM_POLICY } from "./constants";
import { decoyTokens, issueTokens, revokeAllSessions } from "./sessions";
import { randomToken, sha256 } from "./tokens";
import type { AuthContext, AuthTokens, ConsentPurpose } from "./types";

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email("Enter a valid email address."));
const nameSchema = z.string().trim().min(1, "Enter your name.").max(100);

const ipKey = (ctx: AuthContext) => ctx.ip ?? "unknown";
const INVALID = () => new DomainError("unauthenticated", "Invalid email or password");

export interface SignUpInput {
  email: string;
  password: string;
  name?: string;
  /** Purpose-scoped consents captured at sign-up (ADR-010); only granted=true rows are written for omitted ones. */
  consents?: Partial<Record<ConsentPurpose, boolean>>;
}

const appBase = (ctx: AuthContext) => {
  const policy = REALM_POLICY[ctx.realm ?? "web"];
  return process.env[policy.appUrlEnv] ?? policy.appUrlDefault;
};

/**
 * Email + password sign-up. Rate-limited per IP and per email. Password hashed with scrypt.
 *
 * Never reveals whether an email is registered: for an existing address the response has the same shape as a success
 * (session-shaped tokens that are not backed by any session, so the browser lands on sign-in on its next request) and
 * the real owner is emailed that someone tried to register. The email is enqueued, not awaited.
 */
export async function signUpWithPassword(input: SignUpInput, ctx: AuthContext): Promise<AuthTokens> {
  await enforceLimit(`signup:ip:${ipKey(ctx)}`, 5, 3600, "Too many sign-up attempts. Please try again later.");
  const email = emailSchema.parse(input.email);
  const password = passwordSchema.parse(input.password);
  const name = input.name?.trim() ? nameSchema.parse(input.name) : null;

  const passwordHash = await hashPassword(password);
  const consents = Object.entries(input.consents ?? {}) as [ConsentPurpose, boolean][];
  const existed = async () => {
    await enqueueAccountMail({
      to: email,
      subject: "Someone tried to register with your email",
      text: `Someone tried to create an account with this email address, but you already have one.\nIf it was you, sign in or reset your password:\n${appBase(ctx)}/signin\nIf it was not you, you can ignore this message: your account is unchanged.`,
    });
    return decoyTokens(ctx);
  };
  if (await prisma.person.findUnique({ where: { email }, select: { id: true } })) return existed();
  try {
    const person = await prisma.$transaction(async (tx) => {
      const p = await tx.person.create({ data: { email, passwordHash, name }, select: { id: true } });
      for (const [purpose, granted] of consents) {
        await tx.consent.create({ data: { personId: p.id, purpose, granted, source: "web" } });
        await emit(tx, "ConsentChanged", { type: "Person", id: p.id }, { personId: p.id, purpose, granted });
      }
      return p;
    });
    return await issueTokens(person.id, ctx, true);
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return existed(); // lost a create race for the same email
    throw err;
  }
}

/**
 * Rate-limited per IP and per email, with progressive per-account backoff (auth-guard.ts); constant-time compare;
 * generic error message on failure. The backoff is skipped for an IP the account already signed in from, so an
 * attacker hammering a victim's address cannot lock the victim out of their usual network.
 */
export async function signInWithPassword(input: { email: string; password: string }, ctx: AuthContext): Promise<AuthTokens> {
  const parsed = emailSchema.safeParse(input.email);
  const email = parsed.success ? parsed.data : normaliseEmail(String(input.email ?? ""));
  await enforceLimit(`signin:ip:${ipKey(ctx)}`, 20, 60);
  await enforceLimit(`signin:email:${email}`, 5, 60);

  const password = String(input.password ?? "").slice(0, 256);
  const person = parsed.success ? await prisma.person.findUnique({ where: { email } }) : null;
  const wait = parsed.success ? await backoffRemaining("signin", email) : 0;
  if (wait > 0 && !(await knownIp(person?.id, ctx.ip))) {
    await dummyVerify(password); // keep the cost of a locked attempt the same as an unlocked one
    throwBackedOff(wait);
  }
  // Per-account bookkeeping only for well-formed emails: every malformed input would otherwise share one bucket.
  const track = () => (parsed.success ? recordFailure("signin", email, "auth.signin_failed") : Promise.resolve(0));
  if (!person?.passwordHash || person.erasedAt) {
    await dummyVerify(password);
    await track();
    throw INVALID();
  }
  if (!(await verifyPassword(password, person.passwordHash))) {
    await track();
    throw INVALID();
  }
  const tokens = await issueTokens(person.id, ctx, false);
  await clearFailures("signin", email);
  return tokens;
}

const RESET_TTL = 30 * 60;
const resetKey = (tokenHash: string) => `pwreset:${tokenHash}`;

/**
 * Emails a reset link. Always resolves in the same time whether or not the account exists (no enumeration): the mail
 * is enqueued for the worker rather than awaited, and the unknown-email path does the same Redis write. Rate-limited.
 */
export async function requestPasswordReset(email: string, ctx: AuthContext): Promise<void> {
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) return;
  await enforceLimit(`pwreset:email:${parsed.data}`, 3, 3600);
  const person = await prisma.person.findUnique({ where: { email: parsed.data }, select: { id: true, erasedAt: true } });
  const token = randomToken(32);
  if (!person || person.erasedAt) {
    await redis.set(`pwreset-decoy:${sha256(token)}`, "0", "EX", 60); // same Redis round trip as the real path
    return;
  }
  await redis.set(resetKey(sha256(token)), person.id, "EX", RESET_TTL);
  await enqueueAccountMail({
    to: parsed.data,
    subject: "Reset your password",
    text: `Use this link within 30 minutes to reset your password:\n${appBase(ctx)}/reset-password?token=${token}`,
  });
}

/** Single-use token; the password is shared across apps, so resetting revokes sessions in every realm. */
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const password = passwordSchema.parse(newPassword);
  const bad = () => new DomainError("validation", "This reset link is invalid or has expired.");
  if (!token) throw bad();
  const personId = await redis.getdel(resetKey(sha256(token)));
  if (!personId) throw bad();
  const passwordHash = await hashPassword(password);
  const person = await prisma.person.update({ where: { id: personId }, data: { passwordHash }, select: { email: true } });
  await revokeAllSessions(personId);
  // A successful reset is the owner's way out of any backoff an attacker triggered.
  if (person.email) await clearFailures("signin", person.email);
}
