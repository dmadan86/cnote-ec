import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { JWT_ISSUER, REALM_POLICY, type Realm } from "./constants";

const keyCache = new Map<string, Uint8Array>();

/**
 * Signing key for a realm: JWT_SECRET_<REALM> when set, otherwise HKDF(JWT_SECRET, realm) — distinct
 * keys either way, so a token can never verify in another realm even before the `aud` check.
 * Fails fast when the secret is missing or shorter than 32 chars.
 */
export function jwtKey(realm: Realm = "web"): Uint8Array {
  const dedicated = process.env[REALM_POLICY[realm].secretEnv];
  const master = process.env.JWT_SECRET;
  const raw = dedicated || master;
  if (!raw || raw.length < 32) throw new Error(`JWT_SECRET (or ${REALM_POLICY[realm].secretEnv}) must be set and at least 32 characters long`);
  const cacheKey = `${realm}:${dedicated ? "d" : "m"}:${raw}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = dedicated
      ? new TextEncoder().encode(dedicated)
      : new Uint8Array(hkdfSync("sha256", raw, "cnote-jwt", `realm:${realm}`, 32));
    keyCache.set(cacheKey, key);
  }
  return key;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export async function signAccessToken(personId: string, sessionId: string, now = Date.now(), realm: Realm = "web"): Promise<{ token: string; expiresAt: Date }> {
  const iat = Math.floor(now / 1000);
  const exp = iat + REALM_POLICY[realm].accessTtlSeconds;
  const token = await new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(personId)
    .setIssuer(JWT_ISSUER)
    .setAudience(realm)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(jwtKey(realm));
  return { token, expiresAt: new Date(exp * 1000) };
}

/** Returns null for any invalid/expired token or one minted for a different realm. */
export async function verifyAccessToken(token: string, currentDate?: Date, realm: Realm = "web"): Promise<{ personId: string; sessionId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, jwtKey(realm), { issuer: JWT_ISSUER, audience: realm, algorithms: ["HS256"], currentDate });
    if (!payload.sub || typeof payload.sid !== "string") return null;
    return { personId: payload.sub, sessionId: payload.sid };
  } catch {
    return null;
  }
}
