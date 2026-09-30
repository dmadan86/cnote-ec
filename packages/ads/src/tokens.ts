// Signed, single-use click tokens (design 5.6): HMAC over (token id, campaign, listing, surface, slot, price, issued-at).
// A click cannot be forged, replayed or repriced. Single use is enforced by the unique AdClick.tokenId.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface ClickTokenPayload {
  /** unique token id (uuid); AdClick.tokenId */
  t: string;
  c: string; // campaignId
  g: string; // adGroupId
  l: string; // listingId
  s: string; // sellerBusinessId
  f: string; // surface
  n: number; // slot (1-based)
  p: number; // price locked at decision time, paise
  q: string | null; // normalised query
  i: number; // issued at (ms)
}

function secret(): string {
  const s = process.env.ADS_TOKEN_SECRET || process.env.JWT_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") throw new Error("ADS_TOKEN_SECRET (or JWT_SECRET) must be set to sign ad click tokens");
  return "dev-only-ads-token-secret";
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (body: string) => createHmac("sha256", secret()).update(body).digest();

export function signClickToken(p: ClickTokenPayload): string {
  const body = b64(JSON.stringify(p));
  return `${body}.${b64(sign(body))}`;
}

export type VerifiedToken = { ok: true; payload: ClickTokenPayload; expired: boolean } | { ok: false };

export function verifyClickToken(token: string, ttlMinutes: number, now = Date.now()): VerifiedToken {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return { ok: false };
  // Compare the canonical base64url STRING, not decoded bytes: the last character carries unused padding bits, so
  // decoding would accept several spellings of one signature (a malleable token that could dodge click dedupe).
  const want = Buffer.from(b64(sign(body)));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false };
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ClickTokenPayload;
    if (typeof payload.t !== "string" || typeof payload.l !== "string" || typeof payload.p !== "number" || typeof payload.i !== "number") return { ok: false };
    return { ok: true, payload, expired: now - payload.i > ttlMinutes * 60_000 || payload.i > now + 60_000 };
  } catch {
    return { ok: false };
  }
}

/** Rotating salt (changes weekly) so visitor and network hashes cannot be joined across weeks (DPDP: pseudonymous, short-lived). */
export function rotatingSalt(now = new Date()): string {
  const week = Math.floor(now.getTime() / (7 * 86_400_000));
  return createHmac("sha256", secret()).update(`ads-salt:${week}`).digest("hex").slice(0, 32);
}

export function hashVisitor(visitorId: string, now = new Date()): string {
  return createHash("sha256").update(`${rotatingSalt(now)}|v|${visitorId}`).digest("hex").slice(0, 32);
}

/** Coarse network fingerprint: IPv4 /24 or IPv6 /48, salted. */
export function hashNet(ip: string | null | undefined, now = new Date()): string {
  const coarse = coarseIp(ip);
  return createHash("sha256").update(`${rotatingSalt(now)}|n|${coarse}`).digest("hex").slice(0, 32);
}

export function coarseIp(ip: string | null | undefined): string {
  if (!ip) return "none";
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip.replace(/^::ffff:/, ""));
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (ip.includes(":")) return `${ip.toLowerCase().split(":").slice(0, 3).join(":")}::/48`;
  return "other";
}
