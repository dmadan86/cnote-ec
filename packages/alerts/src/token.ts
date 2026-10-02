// One-click unsubscribe links for alert emails (docs/design/buyer-retention.md). The token is an HMAC over (person, alert type); it never
// expires (an unsubscribe link in an old email must keep working) and can only ever TURN OFF one alert type for that person.
import { createHmac, timingSafeEqual } from "node:crypto";
import { ALERT_TYPES, type AlertType } from "./types";

function secret(): string {
  const s = process.env.ALERTS_TOKEN_SECRET || process.env.JWT_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") throw new Error("ALERTS_TOKEN_SECRET (or JWT_SECRET) must be set to sign alert unsubscribe links");
  return "dev-only-alerts-token-secret";
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (body: string) => createHmac("sha256", secret()).update(`alerts-unsub:${body}`).digest();

export function signUnsubscribeToken(personId: string, type: AlertType): string {
  const body = b64(JSON.stringify({ p: personId, t: type }));
  return `${body}.${b64(sign(body))}`;
}

/** Returns the person and alert type, or null for any malformed / forged token. */
export function verifyUnsubscribeToken(token: string): { personId: string; type: AlertType } | null {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  // compare the canonical base64url STRING, not decoded bytes (the last char carries unused padding bits)
  const want = Buffer.from(b64(sign(body)));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { p?: unknown; t?: unknown };
    if (typeof p.p !== "string" || typeof p.t !== "string" || !(ALERT_TYPES as readonly string[]).includes(p.t)) return null;
    return { personId: p.p, type: p.t as AlertType };
  } catch {
    return null;
  }
}

/** Absolute one-click unsubscribe URL for the buyer web app (APP_URL). */
export function alertUnsubscribeUrl(personId: string, type: AlertType): string {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/unsubscribe/alerts?t=${encodeURIComponent(signUnsubscribeToken(personId, type))}`;
}
