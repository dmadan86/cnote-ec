// ONDC cryptography (ADR-017): Authorization header signing (ed25519 over a BLAKE2b-512 body digest) and the
// on_subscribe challenge (x25519 shared secret + AES-256-ECB, as mandated by the ONDC registry spec).
// Keys travel as base64 of the raw libsodium form (ed25519 private = 64 bytes seed||pub, or a bare 32-byte seed;
// public = 32 bytes) or as base64 DER (PKCS8 / SPKI); every accessor accepts both.
import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomUUID,
  sign as edSign, verify as edVerify, type KeyObject,
} from "node:crypto";

const ED_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const ED_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const X_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const X_SPKI = Buffer.from("302a300506032b656e032100", "hex");

export class OndcCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OndcCryptoError";
  }
}

const b64 = (s: string): Buffer => Buffer.from(s.trim(), "base64");

function privateFrom(prefix: Buffer, raw: Buffer, what: string): KeyObject {
  // raw seed (32), libsodium seed||pub (64), or full PKCS8 DER (48)
  const seed = raw.length === 32 ? raw : raw.length === 64 ? raw.subarray(0, 32) : raw.length === prefix.length + 32 && raw.subarray(0, prefix.length).equals(prefix) ? raw.subarray(prefix.length) : null;
  if (!seed) throw new OndcCryptoError(`${what}: unsupported private key length ${raw.length}`);
  return createPrivateKey({ key: Buffer.concat([prefix, seed]), format: "der", type: "pkcs8" });
}
function publicFrom(prefix: Buffer, raw: Buffer, what: string): KeyObject {
  const key = raw.length === 32 ? raw : raw.length === prefix.length + 32 && raw.subarray(0, prefix.length).equals(prefix) ? raw.subarray(prefix.length) : null;
  if (!key) throw new OndcCryptoError(`${what}: unsupported public key length ${raw.length}`);
  return createPublicKey({ key: Buffer.concat([prefix, key]), format: "der", type: "spki" });
}

export const edPrivateKey = (b64Key: string): KeyObject => privateFrom(ED_PKCS8, b64(b64Key), "ed25519 private key");
export const edPublicKey = (b64Key: string): KeyObject => publicFrom(ED_SPKI, b64(b64Key), "ed25519 public key");
export const xPrivateKey = (b64Key: string): KeyObject => privateFrom(X_PKCS8, b64(b64Key), "x25519 private key");
export const xPublicKey = (b64Key: string): KeyObject => publicFrom(X_SPKI, b64(b64Key), "x25519 public key");

/** Derives the base64 raw public key from an ed25519 private key. */
export function edPublicFromPrivate(b64Key: string): string {
  const der = createPublicKey(edPrivateKey(b64Key)).export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(ED_SPKI.length)).toString("base64");
}

/** Fresh key pairs (tests, onboarding scripts). Private keys are returned as libsodium-style base64. */
export function generateSigningKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(ED_PKCS8.length);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(ED_SPKI.length);
  return { privateKey: Buffer.concat([seed, pub]).toString("base64"), publicKey: Buffer.from(pub).toString("base64") };
}
export function generateEncryptionKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return {
    privateKey: Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }).subarray(X_PKCS8.length)).toString("base64"),
    publicKey: Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(X_SPKI.length)).toString("base64"),
  };
}

// ---------------------------------------------------------------------------------------------
// Digest + Authorization header
// ---------------------------------------------------------------------------------------------

/** base64(BLAKE2b-512(body)) per the ONDC signing spec. */
export const blake2bDigest = (body: string | Buffer): string => createHash("blake2b512").update(body).digest("base64");

export interface SigningInput {
  body: string;
  subscriberId: string;
  uniqueKeyId: string;
  privateKey: string;
  /** unix seconds; default now */
  created?: number;
  /** signature lifetime in seconds (default 300) */
  ttlSeconds?: number;
}

export function signingString(created: number, expires: number, digest: string): string {
  return `(created): ${created}\n(expires): ${expires}\ndigest: BLAKE-512=${digest}`;
}

/** Builds `Signature keyId="sub|ukid|ed25519",algorithm="ed25519",created=…,expires=…,headers="(created) (expires) digest",signature="…"`. */
export function buildAuthHeader(i: SigningInput): string {
  const created = i.created ?? Math.floor(Date.now() / 1000);
  const expires = created + (i.ttlSeconds ?? 300);
  const signature = edSign(null, Buffer.from(signingString(created, expires, blake2bDigest(i.body))), edPrivateKey(i.privateKey)).toString("base64");
  return `Signature keyId="${i.subscriberId}|${i.uniqueKeyId}|ed25519",algorithm="ed25519",created="${created}",expires="${expires}",headers="(created) (expires) digest",signature="${signature}"`;
}

export interface ParsedAuthHeader {
  subscriberId: string;
  uniqueKeyId: string;
  algorithm: string;
  created: number;
  expires: number;
  headers: string;
  signature: string;
}

/** Parses an Authorization header; returns null when malformed. */
export function parseAuthHeader(header: string | null | undefined): ParsedAuthHeader | null {
  if (!header || header.length > 2000) return null;
  const m = /^Signature\s+(.*)$/i.exec(header.trim());
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const part of m[1]!.matchAll(/(\w+)="?([^",]*)"?/g)) params[part[1]!] = part[2]!;
  const [subscriberId, uniqueKeyId, alg] = (params.keyId ?? "").split("|");
  const created = Number(params.created);
  const expires = Number(params.expires);
  if (!subscriberId || !uniqueKeyId || !alg || !params.signature || !Number.isInteger(created) || !Number.isInteger(expires)) return null;
  return { subscriberId, uniqueKeyId, algorithm: params.algorithm ?? alg, created, expires, headers: params.headers ?? "", signature: params.signature };
}

export type VerifyResult = { ok: true } | { ok: false; reason: "malformed" | "algorithm" | "headers" | "not_yet_valid" | "expired" | "bad_signature" };

/** Verifies a parsed header against the raw body and the sender's registry public key. */
export function verifyAuthSignature(p: ParsedAuthHeader, body: string, publicKey: string, opts: { now?: number; skewSeconds?: number } = {}): VerifyResult {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const skew = opts.skewSeconds ?? 30;
  if (p.algorithm !== "ed25519") return { ok: false, reason: "algorithm" };
  if (p.headers.trim() !== "(created) (expires) digest") return { ok: false, reason: "headers" };
  if (p.created > now + skew) return { ok: false, reason: "not_yet_valid" };
  if (p.expires < now - skew || p.expires < p.created) return { ok: false, reason: "expired" };
  try {
    const good = edVerify(null, Buffer.from(signingString(p.created, p.expires, blake2bDigest(body))), edPublicKey(publicKey), b64(p.signature));
    return good ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}

// ---------------------------------------------------------------------------------------------
// Registry on_subscribe challenge + site verification
// ---------------------------------------------------------------------------------------------

/** AES-256-ECB key = x25519(our private, registry public). Registry keys come from ONDC's published key sheet. */
export function sharedSecret(encPrivateKey: string, registryEncPublicKey: string): Buffer {
  return diffieHellman({ privateKey: xPrivateKey(encPrivateKey), publicKey: xPublicKey(registryEncPublicKey) });
}

/** Decrypts the registry's `challenge` (base64 AES-256-ECB) and returns the plaintext answer for /on_subscribe. */
export function decryptChallenge(challenge: string, encPrivateKey: string, registryEncPublicKey: string): string {
  try {
    const d = createDecipheriv("aes-256-ecb", sharedSecret(encPrivateKey, registryEncPublicKey), null);
    const plain = Buffer.concat([d.update(b64(challenge)), d.final()]);
    // A wrong key still yields valid PKCS#7 padding about 1 time in 256; registry challenges are printable ASCII,
    // so anything else is a failed decryption, not a challenge.
    if (plain.length === 0 || plain.some((b) => b < 0x20 || b > 0x7e)) throw new Error("not a challenge");
    return plain.toString("utf8");
  } catch {
    throw new OndcCryptoError("challenge could not be decrypted");
  }
}

/** Test/registry helper: the inverse of decryptChallenge. */
export function encryptChallenge(plain: string, registryEncPrivateKey: string, subscriberEncPublicKey: string): string {
  const c = createCipheriv("aes-256-ecb", sharedSecret(registryEncPrivateKey, subscriberEncPublicKey), null);
  return Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("base64");
}

/** base64 ed25519 signature of the subscribe `request_id`, served as the ondc-site-verification meta tag. */
export function signRequestId(requestId: string, signingPrivateKey: string): string {
  return edSign(null, Buffer.from(requestId), edPrivateKey(signingPrivateKey)).toString("base64");
}

const escapeAttr = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** The /ondc-site-verification.html document. */
export function siteVerificationHtml(requestId: string, signingPrivateKey: string): string {
  return `<html>\n  <head>\n    <meta name="ondc-site-verification" content="${escapeAttr(signRequestId(requestId, signingPrivateKey))}" />\n  </head>\n  <body>ONDC Site Verification Page</body>\n</html>\n`;
}

export const newRequestId = (): string => randomUUID();
