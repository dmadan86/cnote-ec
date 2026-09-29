import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hotp, otpauthUri, totp, verifyTotp } from "../src/totp";

// RFC 6238 Appendix B test vectors (8 digits; seeds are the ASCII strings repeated to the hash length).
const seed = { sha1: Buffer.from("12345678901234567890"), sha256: Buffer.from("12345678901234567890123456789012"), sha512: Buffer.from("1234567890123456789012345678901234567890123456789012345678901234") };
const vectors: [number, string, string, string][] = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

describe("RFC 6238 vectors", () => {
  for (const [t, sha1, sha256, sha512] of vectors) {
    it(`T=${t}`, () => {
      expect(totp(seed.sha1, t * 1000, { digits: 8, algorithm: "sha1" })).toBe(sha1);
      expect(totp(seed.sha256, t * 1000, { digits: 8, algorithm: "sha256" })).toBe(sha256);
      expect(totp(seed.sha512, t * 1000, { digits: 8, algorithm: "sha512" })).toBe(sha512);
    });
  }
  it("RFC 4226 HOTP vectors", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((c, i) => expect(hotp(seed.sha1, i)).toBe(c));
  });
});

describe("verifyTotp", () => {
  const secret = seed.sha1;
  const now = 1_700_000_000_000;
  const at = (offsetSteps: number) => totp(secret, now + offsetSteps * 30_000);
  it("accepts the current step and returns it", () => {
    expect(verifyTotp(secret, at(0), { nowMs: now })).toBe(Math.floor(now / 30000));
  });
  it("accepts ±1 step and rejects ±2", () => {
    expect(verifyTotp(secret, at(-1), { nowMs: now })).toBe(Math.floor(now / 30000) - 1);
    expect(verifyTotp(secret, at(1), { nowMs: now })).toBe(Math.floor(now / 30000) + 1);
    expect(verifyTotp(secret, at(-2), { nowMs: now })).toBeNull();
    expect(verifyTotp(secret, at(2), { nowMs: now })).toBeNull();
  });
  it("rejects malformed input", () => {
    for (const c of ["", "12345", "1234567", "abcdef", "12 3456"]) expect(verifyTotp(secret, c, { nowMs: now })).toBeNull();
  });
});

describe("base32 + otpauth", () => {
  it("round-trips and matches RFC 4648 vectors", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI======").toString()).toBe("foobar");
    const b = Buffer.from(Array.from({ length: 20 }, (_, i) => i * 13));
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
    expect(() => base32Decode("!!")).toThrow();
  });
  it("builds a Key URI", () => {
    const u = otpauthUri({ secretBase32: "ABC", account: "a@b.co", issuer: "Cnote Admin" });
    expect(u).toBe("otpauth://totp/Cnote%20Admin:a%40b.co?secret=ABC&issuer=Cnote+Admin&algorithm=SHA1&digits=6&period=30");
  });
});
