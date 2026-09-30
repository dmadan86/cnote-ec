import { describe, expect, it } from "vitest";
import { createHash, sign as edSign } from "node:crypto";
import {
  OndcCryptoError, blake2bDigest, buildAuthHeader, decryptChallenge, edPrivateKey, edPublicFromPrivate, encryptChallenge, generateEncryptionKeyPair,
  generateSigningKeyPair, newRequestId, parseAuthHeader, signRequestId, signingString, siteVerificationHtml, verifyAuthSignature,
} from "../src/crypto";

// RFC 8032 section 7.1, test 1 (empty message)
const RFC_SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC_PUB = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const RFC_SIG = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
const hexB64 = (h: string) => Buffer.from(h, "hex").toString("base64");

describe("test vectors", () => {
  it("BLAKE2b-512 of 'abc' matches RFC 7693 appendix A", () => {
    expect(Buffer.from(blake2bDigest("abc"), "base64").toString("hex")).toBe(
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
    expect(blake2bDigest("abc")).not.toBe(createHash("sha512").update("abc").digest("base64"));
  });

  it("ed25519 matches RFC 8032 test 1 for the seed, in bare-seed and libsodium (seed||pub) form", () => {
    for (const priv of [hexB64(RFC_SEED), hexB64(RFC_SEED + RFC_PUB)]) {
      expect(Buffer.from(edPublicFromPrivate(priv), "base64").toString("hex")).toBe(RFC_PUB);
      expect(edSign(null, Buffer.alloc(0), edPrivateKey(priv)).toString("hex")).toBe(RFC_SIG);
    }
  });

  it("produces a stable Authorization header for fixed inputs (deterministic signature)", () => {
    const h = buildAuthHeader({ body: '{"a":1}', subscriberId: "seller.example.com", uniqueKeyId: "uk-1", privateKey: hexB64(RFC_SEED), created: 1_700_000_000, ttlSeconds: 300 });
    expect(h).toBe('Signature keyId="seller.example.com|uk-1|ed25519",algorithm="ed25519",created="1700000000",expires="1700000300",headers="(created) (expires) digest",signature="G8KM1lom3YAToM3AuE525lNalDzqYES+mct5TC/u0z/vL33BZ/6hDObcI3PD+1gPbzCE8ovtsvvykhiubQ0kCg=="');
    expect(h).toContain('headers="(created) (expires) digest"');
    expect(signingString(1, 2, "D")).toBe("(created): 1\n(expires): 2\ndigest: BLAKE-512=D");
    expect(buildAuthHeader({ body: '{"a":1}', subscriberId: "seller.example.com", uniqueKeyId: "uk-1", privateKey: hexB64(RFC_SEED), created: 1_700_000_000 })).toBe(h);
  });
});

describe("authorization header round trip", () => {
  const { privateKey, publicKey } = generateSigningKeyPair();
  const body = JSON.stringify({ context: { action: "search" }, message: { x: "é✓" } });
  const now = 1_800_000_000;
  const header = buildAuthHeader({ body, subscriberId: "bap.example.com", uniqueKeyId: "k1", privateKey, created: now });
  const parsed = parseAuthHeader(header)!;

  it("parses and verifies", () => {
    expect(parsed).toMatchObject({ subscriberId: "bap.example.com", uniqueKeyId: "k1", algorithm: "ed25519", created: now, expires: now + 300 });
    expect(verifyAuthSignature(parsed, body, publicKey, { now: now + 10 })).toEqual({ ok: true });
  });
  it("rejects a tampered body, wrong key, expiry and future-dated signatures", () => {
    expect(verifyAuthSignature(parsed, body + " ", publicKey, { now })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyAuthSignature(parsed, body, generateSigningKeyPair().publicKey, { now })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyAuthSignature(parsed, body, "not-a-key", { now })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyAuthSignature(parsed, body, publicKey, { now: now + 1000 })).toEqual({ ok: false, reason: "expired" });
    expect(verifyAuthSignature(parsed, body, publicKey, { now: now - 1000 })).toEqual({ ok: false, reason: "not_yet_valid" });
    expect(verifyAuthSignature({ ...parsed, expires: parsed.created - 1 }, body, publicKey, { now })).toMatchObject({ ok: false });
  });
  it("rejects other algorithms and header lists", () => {
    expect(verifyAuthSignature({ ...parsed, algorithm: "rsa" }, body, publicKey, { now })).toEqual({ ok: false, reason: "algorithm" });
    expect(verifyAuthSignature({ ...parsed, headers: "(created)" }, body, publicKey, { now })).toEqual({ ok: false, reason: "headers" });
  });
  it("parse returns null for malformed headers", () => {
    for (const h of [undefined, null, "", "Bearer x", "Signature keyId=\"a|b\"", `Signature keyId="a|b|ed25519",created="x",expires="1",signature="s"`, "S".repeat(3000)]) expect(parseAuthHeader(h as string)).toBeNull();
  });
});

describe("keys", () => {
  it("rejects unsupported key sizes", () => {
    expect(() => edPrivateKey(Buffer.alloc(10).toString("base64"))).toThrow(OndcCryptoError);
    expect(() => verifyAuthSignature(parseAuthHeader(buildAuthHeader({ body: "", subscriberId: "a", uniqueKeyId: "b", privateKey: generateSigningKeyPair().privateKey }))!, "", Buffer.alloc(5).toString("base64"))).not.toThrow();
  });
  it("accepts DER-encoded (PKCS8/SPKI) keys", () => {
    const { privateKey, publicKey } = generateSigningKeyPair();
    const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(privateKey, "base64").subarray(0, 32)]).toString("base64");
    expect(edPublicFromPrivate(der)).toBe(publicKey);
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKey, "base64")]).toString("base64");
    const h = parseAuthHeader(buildAuthHeader({ body: "b", subscriberId: "a", uniqueKeyId: "b", privateKey: der }))!;
    expect(verifyAuthSignature(h, "b", spki)).toEqual({ ok: true });
  });
});

describe("on_subscribe challenge and site verification", () => {
  const ours = generateEncryptionKeyPair();
  const registry = generateEncryptionKeyPair();
  it("decrypts what the registry encrypted (x25519 + AES-256-ECB)", () => {
    const challenge = encryptChallenge("secret-answer-123", registry.privateKey, ours.publicKey);
    expect(decryptChallenge(challenge, ours.privateKey, registry.publicKey)).toBe("secret-answer-123");
  });
  it("fails on a wrong key or garbage", () => {
    const challenge = encryptChallenge("x", registry.privateKey, ours.publicKey);
    expect(() => decryptChallenge(challenge, generateEncryptionKeyPair().privateKey, registry.publicKey)).toThrow(OndcCryptoError);
    expect(() => decryptChallenge("AAAA", ours.privateKey, registry.publicKey)).toThrow(OndcCryptoError);
  });
  it("signs the request id and serves it in the verification page", () => {
    const { privateKey } = generateSigningKeyPair();
    const id = newRequestId();
    const sig = signRequestId(id, privateKey);
    expect(siteVerificationHtml(id, privateKey)).toContain(`content="${sig}"`);
    expect(siteVerificationHtml(id, privateKey)).toContain("ondc-site-verification");
    expect(signRequestId(id, privateKey)).toBe(sig); // deterministic
  });
});
