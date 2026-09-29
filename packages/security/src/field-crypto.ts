// Field-level envelope encryption (AES-256-GCM). Each value gets a fresh 256-bit data key (DEK); the DEK is
// wrapped by a key-management port (local keyring now; AWS KMS / Azure Key Vault / GCP KMS adapters plug in
// without touching callers). The AAD binds a ciphertext to its "context" (e.g. "business.pan:<id>"), so a
// value copied to another row or column fails authentication.
//
// Wire format (all segments base64url, dot-separated):  v1.<kid>.<wrappedDEK>.<iv>.<ct>.<tag>
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";
const KID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class FieldCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldCryptoError";
  }
}

// ---------- KMS port ----------
export interface WrappedKey {
  kid: string;
  wrapped: Buffer;
}
export interface KeyManagementService {
  readonly name: string;
  /** Key id that new data keys are wrapped under. */
  activeKeyId(): string;
  wrap(dek: Buffer, aad: Buffer): Promise<WrappedKey>;
  unwrap(kid: string, wrapped: Buffer, aad: Buffer): Promise<Buffer>;
}

const b64u = (b: Buffer) => b.toString("base64url");
const fromB64u = (s: string) => Buffer.from(s, "base64url");

function aesGcmSeal(key: Buffer, plaintext: Buffer, aad: Buffer) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv, ct, tag: c.getAuthTag() };
}
function aesGcmOpen(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

// ---------- Local keyring adapter ----------
/** "kid1:base64key,kid2:base64key" → Map. Keys are 32 bytes (base64 or base64url). */
export function parseKeyring(spec: string): Map<string, Buffer> {
  const ring = new Map<string, Buffer>();
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    const kid = part.slice(0, i);
    const key = Buffer.from(part.slice(i + 1), "base64");
    if (i < 1 || !KID_RE.test(kid)) throw new FieldCryptoError(`FIELD_ENCRYPTION_KEYS: invalid key id in "${part.slice(0, 12)}…"`);
    if (key.length !== 32) throw new FieldCryptoError(`FIELD_ENCRYPTION_KEYS: key "${kid}" must be 32 bytes (base64)`);
    if (ring.has(kid)) throw new FieldCryptoError(`FIELD_ENCRYPTION_KEYS: duplicate key id "${kid}"`);
    ring.set(kid, key);
  }
  if (ring.size === 0) throw new FieldCryptoError("FIELD_ENCRYPTION_KEYS is empty");
  return ring;
}

/**
 * Keys come from FIELD_ENCRYPTION_KEYS. The first listed key is active unless FIELD_ENCRYPTION_ACTIVE_KID names
 * another. Rotation: add a new key id at the front (keep the old ones to decrypt), deploy, re-encrypt rows with
 * `reencryptField`, then retire the old id.
 */
export function createLocalKms(ring: Map<string, Buffer>, activeKid?: string): KeyManagementService {
  const active = activeKid ?? ring.keys().next().value!;
  if (!ring.has(active)) throw new FieldCryptoError(`Active key id "${active}" is not in the keyring`);
  return {
    name: "local",
    activeKeyId: () => active,
    async wrap(dek, aad) {
      const { iv, ct, tag } = aesGcmSeal(ring.get(active)!, dek, aad);
      return { kid: active, wrapped: Buffer.concat([iv, ct, tag]) };
    },
    async unwrap(kid, wrapped, aad) {
      const kek = ring.get(kid);
      if (!kek) throw new FieldCryptoError(`Unknown key id "${kid}"`);
      if (wrapped.length < 12 + 16 + 1) throw new FieldCryptoError("Malformed wrapped key");
      return aesGcmOpen(kek, wrapped.subarray(0, 12), wrapped.subarray(12, -16), wrapped.subarray(-16), aad);
    },
  };
}

// ---------- Cloud KMS adapter stubs (no SDK deps) ----------
function notImplemented(name: string, how: string): KeyManagementService {
  const fail = (): never => {
    throw new FieldCryptoError(`${name} KMS adapter is not implemented. ${how}`);
  };
  return { name, activeKeyId: fail, wrap: fail, unwrap: fail };
}
/**
 * AWS KMS: implement wrap = `Encrypt({ KeyId: FIELD_KMS_KEY_ARN, Plaintext: dek, EncryptionContext: { ctx: aad.toString() } })`,
 * unwrap = `Decrypt({ CiphertextBlob, EncryptionContext })`; kid = key ARN alias. Or `GenerateDataKey` to avoid local DEK entropy.
 */
export const awsKmsAdapter = () => notImplemented("aws-kms", "Wrap DEKs with kms:Encrypt/Decrypt and EncryptionContext = AAD.");
/** Azure Key Vault: `CryptographyClient.wrapKey("A256KW" or "RSA-OAEP-256", dek)` / `unwrapKey`; kid = key version id. */
export const azureKeyVaultAdapter = () => notImplemented("azure-key-vault", "Wrap DEKs with CryptographyClient.wrapKey/unwrapKey (AAD is bound by the inner AES-GCM layer).");
/** GCP Cloud KMS: `KeyManagementServiceClient.encrypt({ name, plaintext, additionalAuthenticatedData: aad })` / `decrypt`; kid = crypto key version. */
export const gcpKmsAdapter = () => notImplemented("gcp-kms", "Wrap DEKs with kms encrypt/decrypt and additionalAuthenticatedData = AAD.");

let kmsOverride: KeyManagementService | null = null;
let cachedKms: { spec: string; kms: KeyManagementService } | null = null;
let warnedDev = false;

/** Test / custom-KMS hook. Pass null to restore env-based selection. */
export function setKms(kms: KeyManagementService | null): void {
  kmsOverride = kms;
}

/** FIELD_KMS=local (default) | aws | azure | gcp. */
export function getKms(env: Record<string, string | undefined> = process.env): KeyManagementService {
  if (kmsOverride) return kmsOverride;
  switch ((env.FIELD_KMS ?? "local").toLowerCase()) {
    case "aws":
      return awsKmsAdapter();
    case "azure":
      return azureKeyVaultAdapter();
    case "gcp":
      return gcpKmsAdapter();
  }
  let spec = env.FIELD_ENCRYPTION_KEYS;
  if (!spec) {
    if (env.NODE_ENV === "production") throw new FieldCryptoError("FIELD_ENCRYPTION_KEYS is required in production");
    // Deterministic dev-only key so local data survives restarts. Never used in production (see above).
    if (!warnedDev) {
      warnedDev = true;
      console.warn("[security] FIELD_ENCRYPTION_KEYS unset: using an insecure development key");
    }
    spec = `dev:${Buffer.from(hkdfSync("sha256", "cnote-dev-field-key", "cnote", "field-encryption", 32)).toString("base64")}`;
  }
  const full = `${spec}|${env.FIELD_ENCRYPTION_ACTIVE_KID ?? ""}`;
  if (cachedKms?.spec !== full) cachedKms = { spec: full, kms: createLocalKms(parseKeyring(spec), env.FIELD_ENCRYPTION_ACTIVE_KID || undefined) };
  return cachedKms.kms;
}

// ---------- Field encryption ----------
const aadOf = (context: string) => Buffer.from(`${VERSION}|${context}`, "utf8");

function requireContext(context: string) {
  if (!context) throw new FieldCryptoError("An encryption context is required (e.g. \"business.pan:<id>\")");
}

export async function encryptField(plaintext: string, context: string): Promise<string> {
  requireContext(context);
  const kms = getKms();
  const aad = aadOf(context);
  const dek = randomBytes(32);
  try {
    const { kid, wrapped } = await kms.wrap(dek, aad);
    if (!KID_RE.test(kid)) throw new FieldCryptoError("KMS returned an invalid key id");
    const { iv, ct, tag } = aesGcmSeal(dek, Buffer.from(plaintext, "utf8"), aad);
    return [VERSION, kid, b64u(wrapped), b64u(iv), b64u(ct), b64u(tag)].join(".");
  } finally {
    dek.fill(0);
  }
}

function parse(ciphertext: string) {
  const p = ciphertext.split(".");
  if (p.length !== 6 || p[0] !== VERSION || !KID_RE.test(p[1]!)) throw new FieldCryptoError("Malformed ciphertext");
  return { kid: p[1]!, wrapped: fromB64u(p[2]!), iv: fromB64u(p[3]!), ct: fromB64u(p[4]!), tag: fromB64u(p[5]!) };
}

/** Throws FieldCryptoError on any tampering, wrong context or unknown key. */
export async function decryptField(ciphertext: string, context: string): Promise<string> {
  requireContext(context);
  const { kid, wrapped, iv, ct, tag } = parse(ciphertext);
  if (iv.length !== 12 || tag.length !== 16) throw new FieldCryptoError("Malformed ciphertext");
  const aad = aadOf(context);
  let dek: Buffer | null = null;
  try {
    dek = await getKms().unwrap(kid, wrapped, aad);
    return aesGcmOpen(dek, iv, ct, tag, aad).toString("utf8");
  } catch (err) {
    if (err instanceof FieldCryptoError) throw err; // configuration problems (unknown key id, unimplemented KMS)
    // Deliberately opaque: don't tell an attacker whether the key, context or bytes were wrong.
    throw new FieldCryptoError("Decryption failed");
  } finally {
    dek?.fill(0);
  }
}

/** True when the ciphertext was wrapped under a key other than the current active one. */
export function needsReencryption(ciphertext: string): boolean {
  return parse(ciphertext).kid !== getKms().activeKeyId();
}

/** Decrypt with the old key and encrypt under the active key (use in a rotation backfill job). */
export async function reencryptField(ciphertext: string, context: string): Promise<string> {
  return encryptField(await decryptField(ciphertext, context), context);
}

// ---------- Blind index ----------
let warnedBlind = false;
function blindMaster(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env.BLIND_INDEX_KEY;
  if (raw) {
    const key = Buffer.from(raw, "base64");
    if (key.length < 32) throw new FieldCryptoError("BLIND_INDEX_KEY must be at least 32 bytes (base64)");
    return key;
  }
  if (env.NODE_ENV === "production") throw new FieldCryptoError("BLIND_INDEX_KEY is required in production");
  if (!warnedBlind) {
    warnedBlind = true;
    console.warn("[security] BLIND_INDEX_KEY unset: using an insecure development key");
  }
  return Buffer.from("cnote-dev-blind-index-key-0123456789ab");
}

/**
 * Deterministic keyed hash for equality lookups on encrypted columns (e.g. find a business by PAN without
 * decrypting every row). Scoped by `purpose` so the same value indexes differently per column. Use a key
 * separate from the encryption keys and never rotate it casually: rotation means re-indexing every row.
 * Input is normalised (NFKC, trimmed, lower-cased).
 */
export function blindIndex(value: string, purpose: string): string {
  if (!purpose) throw new FieldCryptoError("blindIndex requires a purpose");
  const key = Buffer.from(hkdfSync("sha256", blindMaster(), "cnote-blind-index", purpose, 32));
  return createHmac("sha256", key).update(value.normalize("NFKC").trim().toLowerCase()).digest("hex");
}
