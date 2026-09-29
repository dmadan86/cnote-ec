import { describe, expect, it } from "vitest";
import { isValidGstin, isValidUdyam } from "../src/gstin";
import { hashPassword, passwordProblem, verifyPassword } from "../src/password";
import { computeTrustScore, emptySignals } from "../src/trust";
import { signAccessToken, verifyAccessToken } from "../src/tokens";

describe("scrypt", () => {
  it("hashes and verifies", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong horse battery", h)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
  it("enforces the policy", () => {
    expect(passwordProblem("short")).toBeTruthy();
    expect(passwordProblem("Password123")).toBeTruthy();
    expect(passwordProblem("aaaaaaaaaaaa")).toBeTruthy();
    expect(passwordProblem("a fine long passphrase")).toBeNull();
  });
});

describe("GSTIN / Udyam", () => {
  it("accepts a valid GSTIN", () => expect(isValidGstin("27AAPFU0939F1ZV")).toBe(true));
  it("rejects bad checksum, state, PAN and length", () => {
    expect(isValidGstin("27AAPFU0939F1ZA")).toBe(false);
    expect(isValidGstin("99AAPFU0939F1ZV")).toBe(false);
    expect(isValidGstin("27AAPFU09X9F1ZV")).toBe(false);
    expect(isValidGstin("27AAPFU0939F1Z")).toBe(false);
  });
  it("validates Udyam format", () => {
    expect(isValidUdyam("UDYAM-MH-12-1234567")).toBe(true);
    expect(isValidUdyam("UDYAM-M-12-1234567")).toBe(false);
  });
});

describe("JWT", () => {
  it("signs and verifies", async () => {
    const { token } = await signAccessToken("p1", "s1");
    expect(await verifyAccessToken(token)).toEqual({ personId: "p1", sessionId: "s1" });
  });
  it("rejects expired, tampered tokens", async () => {
    const { token } = await signAccessToken("p1", "s1", Date.now() - 16 * 60 * 1000);
    expect(await verifyAccessToken(token)).toBeNull();
    const ok = (await signAccessToken("p1", "s1")).token;
    expect(await verifyAccessToken(ok.slice(0, -2) + "xx")).toBeNull();
  });
  it("never verifies a token in another realm (distinct keys + audience)", async () => {
    const web = (await signAccessToken("p1", "s1", Date.now(), "web")).token;
    const admin = (await signAccessToken("p1", "s1", Date.now(), "admin")).token;
    expect(await verifyAccessToken(web, undefined, "admin")).toBeNull();
    expect(await verifyAccessToken(web, undefined, "seller")).toBeNull();
    expect(await verifyAccessToken(admin, undefined, "web")).toBeNull();
    expect(await verifyAccessToken(admin, undefined, "admin")).toEqual({ personId: "p1", sessionId: "s1" });
  });
  it("admin access tokens live 5 minutes", async () => {
    const { token } = await signAccessToken("p1", "s1", Date.now() - 6 * 60 * 1000, "admin");
    expect(await verifyAccessToken(token, undefined, "admin")).toBeNull();
    const fresh = await signAccessToken("p1", "s1", Date.now() - 4 * 60 * 1000, "admin");
    expect(await verifyAccessToken(fresh.token, undefined, "admin")).not.toBeNull();
  });
  it("uses a dedicated realm secret when configured", async () => {
    const prev = process.env.JWT_SECRET_SELLER;
    process.env.JWT_SECRET_SELLER = "s".repeat(40);
    const { token } = await signAccessToken("p1", "s1", Date.now(), "seller");
    expect(await verifyAccessToken(token, undefined, "seller")).not.toBeNull();
    process.env.JWT_SECRET_SELLER = "t".repeat(40);
    expect(await verifyAccessToken(token, undefined, "seller")).toBeNull();
    if (prev === undefined) delete process.env.JWT_SECRET_SELLER;
    else process.env.JWT_SECRET_SELLER = prev;
  });
  it("fails fast on a short secret", async () => {
    const prev = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "short";
    await expect(signAccessToken("p", "s")).rejects.toThrow(/JWT_SECRET/);
    process.env.JWT_SECRET = prev;
  });
});

describe("computeTrustScore", () => {
  it("badge needs tier >= 1 and score >= 40", () => {
    expect(computeTrustScore(emptySignals(0)).badgeActive).toBe(false);
    expect(computeTrustScore(emptySignals(1))).toMatchObject({ badgeActive: true });
  });
  it("rewards fast responses and penalises expiries", () => {
    const good = computeTrustScore({ ...emptySignals(1), acceptedFast: 20 }).score;
    const bad = computeTrustScore({ ...emptySignals(1), expired: 20 }).score;
    expect(good).toBeGreaterThan(bad);
    expect(good).toBeLessThanOrEqual(100);
  });
  it("applies moderation, dispute and decay penalties, clamped to 0..100", () => {
    const base = computeTrustScore(emptySignals(1)).score;
    expect(computeTrustScore({ ...emptySignals(1), moderationRejections: 2 }).score).toBe(base - 10);
    expect(computeTrustScore({ ...emptySignals(1), inactiveDays: 90 }).score).toBeLessThan(base);
    const worst = computeTrustScore({ ...emptySignals(1), expired: 500, moderationRejections: 50, disputesLost: 50, inactiveDays: 999 });
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(worst.badgeActive).toBe(false);
  });
});
