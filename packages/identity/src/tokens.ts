import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { ACCESS_TTL_SECONDS, JWT_ISSUER } from "./constants";

let cachedSecret: { raw: string; key: Uint8Array } | undefined;
/** Fails fast when JWT_SECRET is missing or shorter than 32 chars. */
export function jwtKey(): Uint8Array {
  const raw = process.env.JWT_SECRET;
  if (!raw || raw.length < 32) throw new Error("JWT_SECRET must be set and at least 32 characters long");
  if (cachedSecret?.raw !== raw) cachedSecret = { raw, key: new TextEncoder().encode(raw) };
  return cachedSecret.key;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export async function signAccessToken(personId: string, sessionId: string, now = Date.now()): Promise<{ token: string; expiresAt: Date }> {
  const iat = Math.floor(now / 1000);
  const exp = iat + ACCESS_TTL_SECONDS;
  const token = await new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(personId)
    .setIssuer(JWT_ISSUER)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(jwtKey());
  return { token, expiresAt: new Date(exp * 1000) };
}

/** Returns null for any invalid/expired token. */
export async function verifyAccessToken(token: string, currentDate?: Date): Promise<{ personId: string; sessionId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, jwtKey(), { issuer: JWT_ISSUER, algorithms: ["HS256"], currentDate });
    if (!payload.sub || typeof payload.sid !== "string") return null;
    return { personId: payload.sub, sessionId: payload.sid };
  } catch {
    return null;
  }
}
