import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import { isBreachedPassword } from "./breached-passwords";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const maxmem = (n: number, r: number) => 256 * n * r;

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Small inline blocklist of locale-specific / long entries; the bundled top-10k list (breached-passwords.ts) covers the rest.
const COMMON_PASSWORDS = new Set(
  [
    "password12", "password123", "password1234", "passw0rd123", "1234567890", "12345678910", "123456789012", "0123456789",
    "qwertyuiop", "qwerty12345", "qwerty123456", "1q2w3e4r5t", "abcdefghij", "abcd123456", "iloveyou12", "iloveyou123",
    "welcome123", "welcome1234", "administrator", "letmein1234", "changeme123", "admin12345", "admin123456", "monkey12345",
    "dragon12345", "football123", "baseball123", "sunshine123", "princess123", "trustno1234", "111111111111", "1111111111",
    "0000000000", "9876543210", "india123456", "india@12345", "cricket1234", "krishna1234", "shivshakti", "jaishriram",
  ].map((p) => p.toLowerCase()),
);

/** Returns a human-readable problem, or null if the password is acceptable. */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return "Use at least 10 characters.";
  if (password.length > 128) return "Use at most 128 characters.";
  if (COMMON_PASSWORDS.has(password.toLowerCase()) || isBreachedPassword(password)) return "This password is too common. Choose a less guessable one.";
  if (/^(.)\1+$/.test(password)) return "This password is too simple.";
  return null;
}

export const passwordSchema = z.string().superRefine((v, ctx) => {
  const problem = passwordProblem(v);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

/** Format: scrypt$N$r$p$salt(b64)$hash(b64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: maxmem(N, R) });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const [nn, rr, pp] = [Number(n), Number(r), Number(p)];
  // Bound parameters so a tampered/legacy row cannot make verification exhaust memory.
  if (!Number.isInteger(nn) || nn < 1024 || nn > 2 ** 20 || rr < 1 || rr > 32 || pp < 1 || pp > 16) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: nn, r: rr, p: pp, maxmem: maxmem(nn, rr) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | undefined;
/** Burn the same CPU as a real verification when the account doesn't exist (no timing-based enumeration). */
export async function dummyVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword("dummy-password-for-timing");
  await verifyPassword(password, await dummyHash);
}
