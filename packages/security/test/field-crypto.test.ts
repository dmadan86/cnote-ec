import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { blindIndex, createLocalKms, decryptField, encryptField, needsReencryption, parseKeyring, reencryptField, setKms } from "../src";

const key = () => randomBytes(32).toString("base64");
const ring = (...kids: string[]) => new Map(parseKeyring(kids.map((k) => `${k}:${key()}`).join(",")));

afterEach(() => setKms(null));

describe("field encryption", () => {
  it("round-trips and uses the documented wire format", async () => {
    setKms(createLocalKms(ring("k1")));
    const ct = await encryptField("ABCDE1234F", "business.pan:1");
    const parts = ct.split(".");
    expect(parts).toHaveLength(6);
    expect(parts.slice(0, 2)).toEqual(["v1", "k1"]);
    expect(ct).not.toContain("ABCDE1234F");
    expect(await decryptField(ct, "business.pan:1")).toBe("ABCDE1234F");
  });

  it("uses a fresh data key and iv per value", async () => {
    setKms(createLocalKms(ring("k1")));
    expect(await encryptField("x", "c")).not.toBe(await encryptField("x", "c"));
  });

  it("rejects a different context (row swap)", async () => {
    setKms(createLocalKms(ring("k1")));
    const ct = await encryptField("secret", "business.pan:1");
    await expect(decryptField(ct, "business.pan:2")).rejects.toThrow("Decryption failed");
    await expect(decryptField(ct, "business.gstin:1")).rejects.toThrow();
  });

  it("detects tampering in every segment", async () => {
    setKms(createLocalKms(ring("k1")));
    const ct = await encryptField("secret", "ctx");
    const parts = ct.split(".");
    for (const i of [2, 3, 4, 5]) {
      const bad = [...parts];
      const raw = Buffer.from(bad[i]!, "base64url");
      raw[0] = raw[0]! ^ 1;
      bad[i] = raw.toString("base64url");
      await expect(decryptField(bad.join("."), "ctx")).rejects.toThrow();
    }
    await expect(decryptField("v2.k1.a.b.c.d", "ctx")).rejects.toThrow("Malformed");
    await expect(decryptField("garbage", "ctx")).rejects.toThrow("Malformed");
  });

  it("rotates: old ciphertext still decrypts, re-encrypt moves it to the active key", async () => {
    const old = ring("k1");
    setKms(createLocalKms(old));
    const ct1 = await encryptField("pan", "ctx");
    expect(needsReencryption(ct1)).toBe(false);

    const rotated = new Map([["k2", randomBytes(32)], ...old]);
    setKms(createLocalKms(rotated)); // k2 active, k1 retained
    expect(await decryptField(ct1, "ctx")).toBe("pan");
    expect(needsReencryption(ct1)).toBe(true);
    const ct2 = await reencryptField(ct1, "ctx");
    expect(ct2.split(".")[1]).toBe("k2");
    expect(needsReencryption(ct2)).toBe(false);
    expect(await decryptField(ct2, "ctx")).toBe("pan");

    setKms(createLocalKms(new Map([["k2", rotated.get("k2")!]]))); // k1 retired
    await expect(decryptField(ct1, "ctx")).rejects.toThrow("Unknown key id");
    expect(await decryptField(ct2, "ctx")).toBe("pan");
  });

  it("honours an explicit active key id and validates the keyring", () => {
    const r = ring("a", "b");
    expect(createLocalKms(r, "b").activeKeyId()).toBe("b");
    expect(() => createLocalKms(r, "zzz")).toThrow();
    expect(() => parseKeyring("a:c2hvcnQ=")).toThrow("32 bytes");
    expect(() => parseKeyring(`a:${key()},a:${key()}`)).toThrow("duplicate");
    expect(() => parseKeyring("")).toThrow();
  });

  it("cloud KMS stubs fail loudly", async () => {
    const { awsKmsAdapter } = await import("../src");
    setKms(awsKmsAdapter());
    await expect(encryptField("x", "c")).rejects.toThrow("not implemented");
  });

  it("requires a context", async () => {
    setKms(createLocalKms(ring("k1")));
    await expect(encryptField("x", "")).rejects.toThrow("context");
  });
});

describe("blindIndex", () => {
  it("is deterministic, normalised and purpose-scoped", () => {
    expect(blindIndex("ABCDE1234F", "business.pan")).toBe(blindIndex(" abcde1234f ", "business.pan"));
    expect(blindIndex("ABCDE1234F", "business.pan")).not.toBe(blindIndex("ABCDE1234F", "business.gstin"));
    expect(blindIndex("a", "p")).toMatch(/^[0-9a-f]{64}$/);
    expect(() => blindIndex("a", "")).toThrow();
  });
});
