import { DomainError, emit, redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { z } from "zod";
import { enforceLimit } from "./limits";
import { getMailer } from "./mailer";
import { dummyVerify, hashPassword, normaliseEmail, passwordSchema, verifyPassword } from "./password";
import { issueTokens, revokeAllSessions } from "./sessions";
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

/** Email + password sign-up. Rate-limited per IP and per email. Password hashed with scrypt. */
export async function signUpWithPassword(input: SignUpInput, ctx: AuthContext): Promise<AuthTokens> {
  await enforceLimit(`signup:ip:${ipKey(ctx)}`, 5, 3600, "Too many sign-up attempts. Please try again later.");
  const email = emailSchema.parse(input.email);
  const password = passwordSchema.parse(input.password);
  const name = input.name?.trim() ? nameSchema.parse(input.name) : null;

  const passwordHash = await hashPassword(password);
  const consents = Object.entries(input.consents ?? {}) as [ConsentPurpose, boolean][];
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
    if ((err as { code?: string }).code === "P2002") throw new DomainError("conflict", "An account with this email already exists. Try signing in.");
    throw err;
  }
}

/** Rate-limited per IP and per email; constant-time compare; generic error message on failure. */
export async function signInWithPassword(input: { email: string; password: string }, ctx: AuthContext): Promise<AuthTokens> {
  const parsed = emailSchema.safeParse(input.email);
  const email = parsed.success ? parsed.data : normaliseEmail(String(input.email ?? ""));
  await enforceLimit(`signin:ip:${ipKey(ctx)}`, 20, 60);
  await enforceLimit(`signin:email:${email}`, 5, 60);

  const password = String(input.password ?? "").slice(0, 256);
  const person = parsed.success ? await prisma.person.findUnique({ where: { email } }) : null;
  if (!person?.passwordHash || person.erasedAt) {
    await dummyVerify(password);
    throw INVALID();
  }
  if (!(await verifyPassword(password, person.passwordHash))) throw INVALID();
  return issueTokens(person.id, ctx, false);
}

const RESET_TTL = 30 * 60;
const resetKey = (tokenHash: string) => `pwreset:${tokenHash}`;

/** Emails a reset link (dev: logged). Always resolves (no account enumeration). Rate-limited. */
export async function requestPasswordReset(email: string, ctx: AuthContext): Promise<void> {
  void ctx;
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) return;
  await enforceLimit(`pwreset:email:${parsed.data}`, 3, 3600);
  const person = await prisma.person.findUnique({ where: { email: parsed.data }, select: { id: true, erasedAt: true } });
  if (!person || person.erasedAt) return;
  const token = randomToken(32);
  await redis.set(resetKey(sha256(token)), person.id, "EX", RESET_TTL);
  const base = process.env.APP_URL ?? "http://localhost:3000";
  await getMailer().send({
    to: parsed.data,
    subject: "Reset your password",
    text: `Use this link within 30 minutes to reset your password:\n${base}/reset-password?token=${token}`,
  });
}

/** Single-use token; resetting revokes every session. */
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const password = passwordSchema.parse(newPassword);
  const bad = () => new DomainError("validation", "This reset link is invalid or has expired.");
  if (!token) throw bad();
  const personId = await redis.getdel(resetKey(sha256(token)));
  if (!personId) throw bad();
  const passwordHash = await hashPassword(password);
  await prisma.person.update({ where: { id: personId }, data: { passwordHash } });
  await revokeAllSessions(personId);
}
