import { createHmac, timingSafeEqual } from "node:crypto";
import { metaConfig } from "./config";

/** Meta signs the RAW body: `X-Hub-Signature-256: sha256=<hex hmac-sha256(app secret, body)>`. Constant-time compare. */
export function verifySignature(rawBody: string | Uint8Array, signatureHeader: string | null | undefined, appSecret: string | undefined = metaConfig().appSecret): boolean {
  if (!appSecret || !signatureHeader) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
  if (!m) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(m[1]!, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signBody(rawBody: string | Uint8Array, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

/** GET webhook verification handshake (hub.mode / hub.verify_token / hub.challenge). Returns the challenge or null. */
export function verifyChallenge(query: { mode?: string | null; token?: string | null; challenge?: string | null }, verifyToken: string | undefined = metaConfig().verifyToken): string | null {
  if (!verifyToken || query.mode !== "subscribe" || !query.token || !query.challenge) return null;
  const a = Buffer.from(query.token);
  const b = Buffer.from(verifyToken);
  return a.length === b.length && timingSafeEqual(a, b) ? query.challenge : null;
}
