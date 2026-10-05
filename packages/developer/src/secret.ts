import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX_LEN = 12; // "ck_live_" + 4 chars
const FORMAT = /^ck_(live|test)_[A-Za-z0-9_-]{43}$/;

/** `ck_live_<32 random bytes, base64url>` (`ck_test_` outside production). */
export function generateSecret(): string {
  const env = process.env.NODE_ENV === "production" ? "live" : "test";
  return `ck_${env}_${randomBytes(32).toString("base64url")}`;
}
export const prefixOf = (secret: string): string => secret.slice(0, PREFIX_LEN);
/** SHA-256 digest of a 256-bit random API token (not a password: no stretching needed; unchanged so stored digests keep matching). */
export const hashSecret = (token: string): string => createHash("sha256").update(Buffer.from(token, "utf8")).digest("hex");
export const isWellFormedSecret = (s: unknown): s is string => typeof s === "string" && s.length <= 80 && FORMAT.test(s);

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
