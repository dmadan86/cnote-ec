// Signed, short-lived preview tokens: let a seller share an unpublished draft (or open it outside the editor)
// without any login. HMAC-SHA256 with a key derived from JWT_SECRET (purpose-bound); the token names only a storefront id.
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { DomainError } from "@cnote/core";

export const PREVIEW_TTL_SECONDS = 30 * 60;

function key(): Buffer {
  const master = process.env.JWT_SECRET;
  if (!master || master.length < 32) throw new Error("JWT_SECRET must be set (32+ chars) to sign storefront previews");
  return Buffer.from(hkdfSync("sha256", master, "cnote-storefront", "storefront-preview-v1", 32));
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signPreviewToken(storefrontId: string, now = Date.now(), ttlSeconds = PREVIEW_TTL_SECONDS): { token: string; expiresAt: Date } {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const body = b64(JSON.stringify({ v: 1, s: storefrontId, exp }));
  const sig = b64(createHmac("sha256", key()).update(body).digest());
  return { token: `${body}.${sig}`, expiresAt: new Date(exp * 1000) };
}

/** Returns the storefront id or throws a validation DomainError (generic message: expired and forged look the same). */
export function verifyPreviewToken(token: string, now = Date.now()): string {
  const bad = () => new DomainError("forbidden", "This preview link is invalid or has expired.", undefined, "storefront.previewLinkInvalidExpired");
  const [body, sig] = token.split(".");
  if (!body || !sig || token.length > 400) throw bad();
  // canonical base64url string comparison (decoded bytes would accept several spellings of one signature)
  const expected = Buffer.from(createHmac("sha256", key()).update(body).digest("base64url"));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw bad();
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { v?: number; s?: string; exp?: number };
    if (p.v !== 1 || typeof p.s !== "string" || typeof p.exp !== "number" || p.exp * 1000 < now) throw bad();
    return p.s;
  } catch {
    throw bad();
  }
}
