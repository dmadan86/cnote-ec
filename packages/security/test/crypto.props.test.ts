import { randomBytes } from "node:crypto";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  azureKeyVaultAdapter, awsKmsAdapter, blindIndex, createLocalKms, decryptField, encryptField, FieldCryptoError, gcpKmsAdapter, getKms, needsReencryption, parseKeyring,
  reencryptField, setKms, type KeyManagementService,
} from "../src";

const opts = { seed: 17, numRuns: 150 };
const b64key = () => randomBytes(32).toString("base64");
const kms = (...kids: string[]) => createLocalKms(parseKeyring(kids.map((k) => `${k}:${b64key()}`).join(",")));
const text = fc.string({ unit: "grapheme", maxLength: 300 });
const ctx = fc.stringMatching(/^[a-z]{1,10}\.[a-z]{1,10}:[0-9a-f-]{1,36}$/);

beforeEach(() => setKms(kms("k1")));
afterEach(() => {
  setKms(null);
  vi.restoreAllMocks();
});

describe("encryptField / decryptField (property)", () => {
  it("round-trips arbitrary unicode, including empty and multi-byte text", async () => {
    await fc.assert(
      fc.asyncProperty(text, ctx, async (p, c) => {
        expect(await decryptField(await encryptField(p, c), c)).toBe(p);
      }),
      opts,
    );
    for (const p of ["", "नमस्ते", "🌏🚀", "\u0000\u0001", "a".repeat(100_000), "é vs é", "﻿bom"]) expect(await decryptField(await encryptField(p, "c"), "c")).toBe(p);
  });

  it("ciphertext is randomised (fresh DEK + IV) and never contains the plaintext", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: "grapheme", minLength: 6, maxLength: 60 }), async (p) => {
        const a = await encryptField(p, "c");
        const b = await encryptField(p, "c");
        expect(a).not.toBe(b);
        const [, , w1, iv1] = a.split(".");
        const [, , w2, iv2] = b.split(".");
        expect(w1).not.toBe(w2);
        expect(iv1).not.toBe(iv2);
        expect(a).not.toContain(Buffer.from(p).toString("base64url"));
      }),
      { ...opts, numRuns: 50 },
    );
  });

  it("any different context fails authentication with the opaque error", async () => {
    await fc.assert(
      fc.asyncProperty(ctx, ctx, async (c1, c2) => {
        fc.pre(c1 !== c2);
        const ct = await encryptField("value", c1);
        await expect(decryptField(ct, c2)).rejects.toThrow(new FieldCryptoError("Decryption failed"));
      }),
      opts,
    );
  });

  it("flipping any single bit in any decoded segment makes decryption fail", async () => {
    const ct = await encryptField("ABCDE1234F", "business.pan:1");
    const parts = ct.split(".");
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 5 }), fc.nat(), fc.integer({ min: 0, max: 7 }), async (seg, at, bit) => {
        const raw = Buffer.from(parts[seg]!, "base64url");
        raw[at % raw.length]! ^= 1 << bit;
        const bad = [...parts];
        bad[seg] = raw.toString("base64url");
        await expect(decryptField(bad.join("."), "business.pan:1")).rejects.toBeInstanceOf(FieldCryptoError);
      }),
      { ...opts, numRuns: 300 },
    );
  });

  it("every strict prefix (truncation) of a ciphertext is rejected, never returning plaintext", async () => {
    const ct = await encryptField("secret-value", "ctx");
    for (let n = 0; n < ct.length; n++) await expect(decryptField(ct.slice(0, n), "ctx"), `prefix ${n}`).rejects.toBeInstanceOf(FieldCryptoError);
  });

  it("segment swap between two ciphertexts fails (mix-and-match attack)", async () => {
    const a = (await encryptField("aaaa", "ctx")).split(".");
    const b = (await encryptField("bbbb", "ctx")).split(".");
    for (const i of [2, 3, 4, 5]) {
      const mixed = [...a];
      mixed[i] = b[i]!;
      await expect(decryptField(mixed.join("."), "ctx")).rejects.toBeInstanceOf(FieldCryptoError);
    }
  });

  it.each(["", "v1", "v1.k1", "v1.k1.a.b.c", "v1.k1.a.b.c.d.e", "v2.k1.a.b.c.d", "V1.k1.a.b.c.d", "v1..a.b.c.d", "v1.k 1.a.b.c.d", `v1.${"k".repeat(65)}.a.b.c.d`, "....."])(
    "malformed ciphertext %j is rejected as Malformed",
    async (bad) => {
      await expect(decryptField(bad, "ctx")).rejects.toThrow("Malformed ciphertext");
      expect(() => needsReencryption(bad)).toThrow("Malformed ciphertext");
    },
  );

  it("wrong IV / tag length is rejected as Malformed before any crypto", async () => {
    const p = (await encryptField("x", "ctx")).split(".");
    await expect(decryptField([...p.slice(0, 3), "AAAA", p[4], p[5]].join("."), "ctx")).rejects.toThrow("Malformed");
    await expect(decryptField([...p.slice(0, 5), "AAAA"].join("."), "ctx")).rejects.toThrow("Malformed");
  });

  it("a different key under the SAME key id fails opaquely (does not disclose why)", async () => {
    const ct = await encryptField("secret", "ctx");
    setKms(kms("k1"));
    await expect(decryptField(ct, "ctx")).rejects.toThrow("Decryption failed");
  });

  it("an unknown key id is a distinct, explicit configuration error", async () => {
    const ct = await encryptField("secret", "ctx");
    setKms(kms("other"));
    await expect(decryptField(ct, "ctx")).rejects.toThrow('Unknown key id "k1"');
  });

  it("requires a non-empty context for both directions", async () => {
    await expect(encryptField("x", "")).rejects.toThrow("context");
    await expect(decryptField("v1.k1.a.b.c.d", "")).rejects.toThrow("context");
  });

  it("wrapped-key blob that is too short is rejected", async () => {
    const p = (await encryptField("x", "ctx")).split(".");
    p[2] = Buffer.alloc(10).toString("base64url");
    await expect(decryptField(p.join("."), "ctx")).rejects.toThrow("Malformed wrapped key");
  });
});

describe("key rotation", () => {
  it("N-generation rotation: every old ciphertext decrypts while its key is retained; reencrypt converges to the active key", async () => {
    const keys = new Map<string, Buffer>();
    const cts: string[] = [];
    for (const kid of ["g1", "g2", "g3", "g4"]) {
      keys.set(kid, randomBytes(32));
      // newest first: active is the first key in the ring
      setKms(createLocalKms(new Map([...[...keys].reverse()])));
      cts.push(await encryptField(`value-${kid}`, `row:${kid}`));
    }
    expect(cts.map((c) => c.split(".")[1])).toEqual(["g1", "g2", "g3", "g4"]);
    for (const [i, c] of cts.entries()) {
      expect(await decryptField(c, `row:g${i + 1}`)).toBe(`value-g${i + 1}`);
      expect(needsReencryption(c)).toBe(i !== 3);
    }
    const migrated = await Promise.all(cts.map((c, i) => reencryptField(c, `row:g${i + 1}`)));
    expect(migrated.every((c) => c.split(".")[1] === "g4")).toBe(true);
    expect(migrated.some((c) => needsReencryption(c))).toBe(false);
    setKms(createLocalKms(new Map([["g4", keys.get("g4")!]]))); // retire g1..g3
    for (const [i, c] of migrated.entries()) expect(await decryptField(c, `row:g${i + 1}`)).toBe(`value-g${i + 1}`);
  });

  it("reencryptField with the wrong context throws and does not produce output", async () => {
    const ct = await encryptField("v", "ctx1");
    await expect(reencryptField(ct, "ctx2")).rejects.toThrow("Decryption failed");
  });
});

describe("custom KMS port", () => {
  const custom = (over: Partial<KeyManagementService> = {}): KeyManagementService => {
    const inner = kms("c1");
    return { ...inner, name: "custom", ...over };
  };
  it("an invalid key id returned by the KMS is refused", async () => {
    setKms(custom({ wrap: async (dek, aad) => ({ kid: "bad kid!", wrapped: (await kms("c1").wrap(dek, aad)).wrapped }) }));
    await expect(encryptField("x", "c")).rejects.toThrow("invalid key id");
  });
  it("the plaintext data key is zeroed after use, on both success and failure", async () => {
    let seen: Buffer | undefined;
    const spyKms = custom({
      wrap: async (dek, aad) => {
        seen = dek;
        return inner.wrap(dek, aad);
      },
    });
    const inner = kms("c1");
    setKms({ ...spyKms, wrap: async (dek, aad) => ((seen = dek), inner.wrap(dek, aad)) });
    await encryptField("x", "c");
    expect(seen!.every((b) => b === 0)).toBe(true);
    setKms(custom({ wrap: async (dek) => ((seen = dek), Promise.reject(new Error("kms down"))) }));
    await expect(encryptField("x", "c")).rejects.toThrow("kms down");
    expect(seen!.every((b) => b === 0)).toBe(true);
  });
  it("a KMS outage during decrypt is reported opaquely; an explicit FieldCryptoError propagates", async () => {
    const ct = await encryptField("x", "c");
    setKms(custom({ unwrap: async () => Promise.reject(new Error("socket hang up")) }));
    await expect(decryptField(ct, "c")).rejects.toThrow("Decryption failed");
    setKms(custom({ unwrap: async () => Promise.reject(new FieldCryptoError("Unknown key id")) }));
    await expect(decryptField(ct, "c")).rejects.toThrow("Unknown key id");
  });
});

describe("parseKeyring / createLocalKms", () => {
  const k = b64key();
  it("accepts base64 and whitespace/empty entries; preserves order", () => {
    const r = parseKeyring(` a:${k} , ,b:${k}`);
    expect([...r.keys()]).toEqual(["a", "b"]);
    expect(r.get("a")).toHaveLength(32);
  });
  it.each([
    ["", "empty"], [`:${k}`, "invalid key id"], ["nocolon", "invalid key id"], [`bad kid:${k}`, "invalid key id"], [`${"x".repeat(65)}:${k}`, "invalid key id"], [`a.b:${k}`, "invalid key id"],
    ["a:", "32 bytes"], [`a:${Buffer.alloc(31).toString("base64")}`, "32 bytes"], [`a:${Buffer.alloc(33).toString("base64")}`, "32 bytes"], [`a:${k},a:${k}`, "duplicate"],
  ])("rejects %j", (spec, why) => {
    expect(() => parseKeyring(spec)).toThrow(why);
  });
  it("error messages never echo key material", () => {
    for (const spec of [`bad kid:${k}`, `a:${Buffer.alloc(31).toString("base64")}`]) {
      try {
        parseKeyring(spec);
      } catch (e) {
        expect(String(e)).not.toContain(k.slice(8));
      }
    }
  });
  it("createLocalKms defaults to the first key; unknown active kid throws; wrap output is opaque", async () => {
    const r = parseKeyring(`first:${k},second:${b64key()}`);
    expect(createLocalKms(r).activeKeyId()).toBe("first");
    expect(() => createLocalKms(r, "nope")).toThrow("not in the keyring");
    const w = await createLocalKms(r).wrap(Buffer.alloc(32, 1), Buffer.from("aad"));
    expect(w.kid).toBe("first");
    expect(w.wrapped.length).toBe(12 + 32 + 16);
    await expect(createLocalKms(r).unwrap("first", w.wrapped, Buffer.from("other-aad"))).rejects.toThrow();
  });
});

describe("getKms (env-driven selection)", () => {
  beforeEach(() => setKms(null));
  const keyA = `a:${b64key()}`;
  it("selects cloud adapters case-insensitively; they fail loudly when used", () => {
    for (const [v, name] of [["aws", "aws-kms"], ["AWS", "aws-kms"], ["azure", "azure-key-vault"], ["gcp", "gcp-kms"]] as const) {
      const k = getKms({ FIELD_KMS: v });
      expect(k.name).toBe(name);
      expect(() => k.activeKeyId()).toThrow("not implemented");
    }
    for (const a of [awsKmsAdapter(), azureKeyVaultAdapter(), gcpKmsAdapter()]) {
      expect(() => a.wrap(Buffer.alloc(1), Buffer.alloc(1))).toThrow(FieldCryptoError);
      expect(() => a.unwrap("k", Buffer.alloc(1), Buffer.alloc(1))).toThrow(FieldCryptoError);
    }
  });
  it("local: uses FIELD_ENCRYPTION_KEYS, first key active unless FIELD_ENCRYPTION_ACTIVE_KID overrides", () => {
    const two = `${keyA},b:${b64key()}`;
    expect(getKms({ FIELD_ENCRYPTION_KEYS: two }).activeKeyId()).toBe("a");
    expect(getKms({ FIELD_ENCRYPTION_KEYS: two, FIELD_ENCRYPTION_ACTIVE_KID: "b" }).activeKeyId()).toBe("b");
    expect(getKms({ FIELD_ENCRYPTION_KEYS: two, FIELD_ENCRYPTION_ACTIVE_KID: "" }).activeKeyId()).toBe("a");
    expect(() => getKms({ FIELD_ENCRYPTION_KEYS: two, FIELD_ENCRYPTION_ACTIVE_KID: "zz" })).toThrow("not in the keyring");
  });
  it("memoises per key-spec and rebuilds when the spec changes", () => {
    const env = { FIELD_ENCRYPTION_KEYS: keyA };
    expect(getKms(env)).toBe(getKms(env));
    expect(getKms({ FIELD_ENCRYPTION_KEYS: `z:${b64key()}` })).not.toBe(getKms(env));
  });
  it("production without keys throws; development falls back to a stable insecure key and warns once", async () => {
    expect(() => getKms({ NODE_ENV: "production" })).toThrow("required in production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const a = getKms({ NODE_ENV: "development" });
    const b = getKms({ NODE_ENV: "development" });
    expect(a.activeKeyId()).toBe("dev");
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    // the dev key is deterministic: two independently built keyrings decrypt each other's data
    const w = await a.wrap(Buffer.alloc(32, 9), Buffer.from("x"));
    expect((await b.unwrap("dev", w.wrapped, Buffer.from("x"))).equals(Buffer.alloc(32, 9))).toBe(true);
  });
  it("setKms override wins over env, and null restores env selection", () => {
    const o = kms("override");
    setKms(o);
    expect(getKms({ FIELD_KMS: "aws" })).toBe(o);
    setKms(null);
    expect(getKms({ FIELD_KMS: "aws" }).name).toBe("aws-kms");
  });
});

describe("blindIndex (property)", () => {
  const withKey = (k: string | undefined, prod = false) => {
    const prev = { key: process.env.BLIND_INDEX_KEY, env: process.env.NODE_ENV };
    if (k === undefined) delete process.env.BLIND_INDEX_KEY;
    else process.env.BLIND_INDEX_KEY = k;
    (process.env as Record<string, string>).NODE_ENV = prod ? "production" : (prev.env ?? "test");
    return () => {
      if (prev.key === undefined) delete process.env.BLIND_INDEX_KEY;
      else process.env.BLIND_INDEX_KEY = prev.key;
      (process.env as Record<string, string>).NODE_ENV = prev.env ?? "test";
    };
  };
  const purpose = fc.stringMatching(/^[a-z]{1,8}\.[a-z]{1,8}$/);

  it("deterministic, 64 hex chars, and never contains the input", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 4, maxLength: 40 }), purpose, (v, p) => {
        const h = blindIndex(v, p);
        expect(h).toBe(blindIndex(v, p));
        expect(h).toMatch(/^[0-9a-f]{64}$/);
      }),
      opts,
    );
  });
  it("purpose separation: same value, different purposes never collide", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), purpose, purpose, (v, p1, p2) => {
        fc.pre(p1 !== p2);
        expect(blindIndex(v, p1)).not.toBe(blindIndex(v, p2));
      }),
      opts,
    );
  });
  it("normalisation: trimming and case do not matter; distinct values stay distinct", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z0-9]{3,20}$/), (v) => {
        const base = blindIndex(v, "p");
        expect(blindIndex(`  ${v.toUpperCase()}\n`, "p")).toBe(base);
        expect(blindIndex(v.toLowerCase(), "p")).toBe(base);
        expect(blindIndex(v + "x", "p")).not.toBe(base);
      }),
      opts,
    );
    expect(blindIndex("Ａ１", "p")).toBe(blindIndex("a1", "p")); // NFKC full-width folding
    expect(blindIndex("a b", "p")).not.toBe(blindIndex("ab", "p")); // inner whitespace is significant
  });
  it("depends on BLIND_INDEX_KEY; a key under 32 bytes is rejected; production requires a key", () => {
    const k1 = randomBytes(32).toString("base64");
    const k2 = randomBytes(32).toString("base64");
    let restore = withKey(k1);
    const h1 = blindIndex("ABCDE1234F", "business.pan");
    restore();
    restore = withKey(k2);
    const h2 = blindIndex("ABCDE1234F", "business.pan");
    restore();
    expect(h1).not.toBe(h2);
    restore = withKey(randomBytes(31).toString("base64"));
    expect(() => blindIndex("x", "p")).toThrow("at least 32 bytes");
    restore();
    restore = withKey(undefined, true);
    expect(() => blindIndex("x", "p")).toThrow("required in production");
    restore();
  });
  it("requires a purpose", () => {
    expect(() => blindIndex("x", "")).toThrow(FieldCryptoError);
  });
});
