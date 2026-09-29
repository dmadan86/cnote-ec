// RFC 6238 TOTP (RFC 4226 HOTP + RFC 4648 base32) on node:crypto only. Pure functions: no I/O.
import { createHmac, timingSafeEqual } from "node:crypto";

export type TotpAlgorithm = "sha1" | "sha256" | "sha512";
export interface TotpOptions {
  /** Time step in seconds. Default 30. */
  step?: number;
  digits?: number;
  /** Default sha1: the only algorithm every authenticator app supports. */
  algorithm?: TotpAlgorithm;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP. */
export function hotp(secret: Buffer, counter: number | bigint, digits = 6, algorithm: TotpAlgorithm = "sha1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(algorithm, secret).update(msg).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const totpStep = (timeMs: number, step = 30) => Math.floor(timeMs / 1000 / step);

/** RFC 6238 code for a moment in time. */
export function totp(secret: Buffer, timeMs: number, o: TotpOptions = {}): string {
  return hotp(secret, totpStep(timeMs, o.step), o.digits ?? 6, o.algorithm ?? "sha1");
}

const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Checks `code` against the steps in [now-window, now+window] (default ±1 = ±30s of clock drift).
 * Returns the matching step, or null. Callers persist the step to block replay (see mfa.ts).
 * All candidate steps are always evaluated so timing does not reveal which one matched.
 */
export function verifyTotp(secret: Buffer, code: string, o: TotpOptions & { nowMs?: number; window?: number } = {}): number | null {
  const digits = o.digits ?? 6;
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return null;
  const now = totpStep(o.nowMs ?? Date.now(), o.step);
  const window = o.window ?? 1;
  let matched: number | null = null;
  for (let s = now - window; s <= now + window; s++) {
    if (safeEq(hotp(secret, s, digits, o.algorithm ?? "sha1"), code) && matched === null) matched = s;
  }
  return matched;
}

/** otpauth:// URI for authenticator-app QR codes (Key URI Format). */
export function otpauthUri(o: { secretBase32: string; account: string; issuer: string; digits?: number; period?: number }): string {
  const label = `${encodeURIComponent(o.issuer)}:${encodeURIComponent(o.account)}`;
  const q = new URLSearchParams({ secret: o.secretBase32, issuer: o.issuer, algorithm: "SHA1", digits: String(o.digits ?? 6), period: String(o.period ?? 30) });
  return `otpauth://totp/${label}?${q.toString()}`;
}
