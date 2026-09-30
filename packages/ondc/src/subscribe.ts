// Registry onboarding endpoints (ADR-017): POST /on_subscribe (challenge) and GET /ondc-site-verification.html.
import { z } from "zod";
import { loadConfig, type OndcConfig } from "./config";
import { decryptChallenge, siteVerificationHtml } from "./crypto";

const body = z.object({ subscriber_id: z.string().min(1).max(255), challenge: z.string().min(1).max(4096) });

/** Answers the registry's on_subscribe: decrypts the challenge with our x25519 key and returns `{ answer }`. */
export function handleOnSubscribe(raw: unknown, cfg: OndcConfig = loadConfig()): { status: number; body: { answer: string } | { error: string } } {
  if (!cfg.enabled) return { status: 404, body: { error: "not found" } };
  const parsed = body.safeParse(raw);
  if (!parsed.success) return { status: 400, body: { error: "bad request" } };
  if (parsed.data.subscriber_id !== cfg.subscriberId) return { status: 400, body: { error: "unknown subscriber" } };
  if (!cfg.encryptionPrivateKey || !cfg.registryEncryptionPublicKey) return { status: 503, body: { error: "encryption keys not configured" } };
  try {
    return { status: 200, body: { answer: decryptChallenge(parsed.data.challenge, cfg.encryptionPrivateKey, cfg.registryEncryptionPublicKey) } };
  } catch {
    return { status: 400, body: { error: "challenge could not be decrypted" } };
  }
}

/** The HTML for /ondc-site-verification.html; `requestId` is ONDC_SITE_REQUEST_ID (the id used in the subscribe call). */
export function siteVerification(cfg: OndcConfig = loadConfig(), requestId: string | undefined = process.env.ONDC_SITE_REQUEST_ID): string | null {
  if (!cfg.enabled || !cfg.signingPrivateKey || !requestId) return null;
  return siteVerificationHtml(requestId, cfg.signingPrivateKey);
}
