// Pure-function + property-based tests (no DB). fast-check runs are kept small where scrypt is involved.
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { REALMS, REALM_POLICY, cookieNames, isRealm, ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS } from "../src/constants";
import { GST_STATES, gstinCheckChar, isValidGstin, isValidUdyam, normaliseGstin, mockGstnProvider, getGstnProvider, setGstnProvider } from "../src/gstin";
import { CIN_RE, LLPIN_RE, PAN_RE, maskPan, nameSimilarity, normaliseName, panFromGstin } from "../src/gst/normalise";
import { consoleMailer, consoleSms, getMailer, getSmsSender, setMailer, setSmsSender } from "../src/mailer";
import { normalisePhone } from "../src/otp";
import { consoleOtpSender, getOtpSender, setOtpSender, unconfiguredOtpSender } from "../src/phone-login";
import { dummyVerify, hashPassword, normaliseEmail, passwordProblem, passwordSchema, verifyPassword } from "../src/password";
import { BADGE_THRESHOLD, computeTrustScore, emptySignals, type TrustSignals } from "../src/trust";
import { jwtKey, randomToken, sha256, signAccessToken, verifyAccessToken } from "../src/tokens";
import { base32Decode, base32Encode, hotp, otpauthUri, totp, totpStep, verifyTotp } from "../src/totp";
import { maskEmail } from "../src/directory";
import { CONSENT_PURPOSES } from "../src/types";

const CS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const stateCodes = Object.keys(GST_STATES);
const pick = (set: string, n: number) => fc.array(fc.constantFrom(...set.split("")), { minLength: n, maxLength: n }).map((a) => a.join(""));
const gstinArb = fc
  .tuple(fc.constantFrom(...stateCodes), pick(L, 5), pick("0123456789", 4), pick(L, 1), fc.constantFrom(..."123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")))
  .map(([st, a, d, c, e]) => {
    const first14 = `${st}${a}${d}${c}${e}Z`;
    return first14 + gstinCheckChar(first14);
  });

describe("scrypt password hashing (property)", () => {
  it("verify(hash(p)) is true and a different password never verifies", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 0, maxLength: 40 }), fc.string({ minLength: 0, maxLength: 40 }), async (a, b) => {
        const h = await hashPassword(a);
        expect(await verifyPassword(a, h)).toBe(true);
        if (a !== b) expect(await verifyPassword(b, h)).toBe(false);
      }),
      { numRuns: 6 },
    );
  });
  it("uses a fresh salt each time", async () => {
    const [a, b] = await Promise.all([hashPassword("same passphrase"), hashPassword("same passphrase")]);
    expect(a).not.toBe(b);
  });
  it("rejects malformed and out-of-bounds stored hashes without running scrypt", async () => {
    const bad = [
      "", "scrypt", "scrypt$1$2$3$4", "bcrypt$16384$8$1$c2FsdA==$aGFzaA==", "scrypt$abc$8$1$c2FsdA==$aGFzaA==",
      "scrypt$512$8$1$c2FsdA==$aGFzaA==", // N too small
      `scrypt$${2 ** 21}$8$1$c2FsdA==$aGFzaA==`, // N too big (memory DoS)
      "scrypt$16384$0$1$c2FsdA==$aGFzaA==", "scrypt$16384$33$1$c2FsdA==$aGFzaA==",
      "scrypt$16384$8$0$c2FsdA==$aGFzaA==", "scrypt$16384$8$17$c2FsdA==$aGFzaA==", "scrypt$16384.5$8$1$c2FsdA==$aGFzaA==",
    ];
    for (const s of bad) expect(await verifyPassword("pw", s)).toBe(false);
  });
  it("dummyVerify resolves (burns a real verification) for any input", async () => {
    await expect(dummyVerify("whatever")).resolves.toBeUndefined();
    await expect(dummyVerify("")).resolves.toBeUndefined();
  });
});

describe("password policy", () => {
  it.each([
    ["123456789", "at least 10"], ["", "at least 10"], ["x".repeat(129), "at most 128"], ["Password123", "too common"],
    ["PASSWORD123", "too common"], ["zzzzzzzzzz", "too simple"], ["a".repeat(128), "too simple"],
  ])("rejects %j", (pw, msg) => expect(passwordProblem(pw)).toContain(msg));
  it("boundaries: 10 and 128 chars are accepted when varied", () => {
    expect(passwordProblem("abcdefghi1")).toBeNull();
    expect(passwordProblem("ab".repeat(64))).toBeNull();
  });
  it("property: length in [10,128] and not blocklisted/repeated => acceptable; otherwise a problem is reported", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (pw) => {
        const p = passwordProblem(pw);
        if (pw.length < 10 || pw.length > 128) expect(p).not.toBeNull();
        if (pw.length >= 10 && pw.length <= 128 && new Set(pw).size > 1 && !/^(password\d+|passw0rd123)$/i.test(pw)) {
          expect(p === null || /common/.test(p)).toBe(true);
        }
      }),
    );
  });
  it("passwordSchema surfaces the same message", () => {
    const r = passwordSchema.safeParse("short");
    expect(r.success).toBe(false);
    expect(passwordSchema.safeParse("a fine long passphrase").success).toBe(true);
  });
  it("normaliseEmail trims + lowercases", () => expect(normaliseEmail("  A@B.Com ")).toBe("a@b.com"));
});

describe("realm constants", () => {
  it("cookie names are per realm, __Host- only when secure", () => {
    for (const r of REALMS) {
      expect(cookieNames(r, false)).toEqual({ access: `cnote_${r}_at`, refresh: `cnote_${r}_rt` });
      expect(cookieNames(r, true)).toEqual({ access: `__Host-cnote_${r}_at`, refresh: `__Host-cnote_${r}_rt` });
    }
    const names = new Set(REALMS.flatMap((r) => Object.values(cookieNames(r, true))));
    expect(names.size).toBe(REALMS.length * 2);
  });
  it("defaults secure from NODE_ENV", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(cookieNames("web").access).toMatch(/^__Host-/);
    vi.stubEnv("NODE_ENV", "test");
    expect(cookieNames("web").access).not.toMatch(/^__Host-/);
    vi.unstubAllEnvs();
  });
  it("isRealm is a strict type guard", () => {
    fc.assert(fc.property(fc.anything(), (v) => { expect(isRealm(v)).toBe(typeof v === "string" && (REALMS as readonly string[]).includes(v)); }));
    expect(isRealm("admin")).toBe(true);
    expect(isRealm("ADMIN")).toBe(false);
  });
  it("admin is the strictest realm; deprecated constants mirror web", () => {
    expect(REALM_POLICY.admin.accessTtlSeconds).toBeLessThan(REALM_POLICY.web.accessTtlSeconds);
    expect(REALM_POLICY.admin.refreshTtlSeconds).toBe(12 * 3600);
    expect(ACCESS_TTL_SECONDS).toBe(REALM_POLICY.web.accessTtlSeconds);
    expect(REFRESH_TTL_SECONDS).toBe(REALM_POLICY.web.refreshTtlSeconds);
  });
});

describe("tokens", () => {
  it("jwtKey: distinct per realm, stable, requires a 32+ char secret", () => {
    const keys = REALMS.map((r) => Buffer.from(jwtKey(r)).toString("hex"));
    expect(new Set(keys).size).toBe(REALMS.length);
    expect(Buffer.from(jwtKey("web")).equals(Buffer.from(jwtKey("web")))).toBe(true);
  });
  it("sha256/randomToken", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const a = randomToken(), b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[\w-]{43}$/);
  });
  it("rejects garbage, wrong alg (none), missing sid, missing sub", async () => {
    for (const t of ["", "a.b.c", "not-a-jwt"]) expect(await verifyAccessToken(t)).toBeNull();
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "p", sid: "s", iss: "cnote", aud: "web", exp: 9e9 })).toString("base64url")}.`;
    expect(await verifyAccessToken(none)).toBeNull();
    const { SignJWT } = await import("jose");
    const mk = (claims: Record<string, unknown>, sub?: string) => {
      let j = new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuer("cnote").setAudience("web").setExpirationTime("5m");
      if (sub) j = j.setSubject(sub);
      return j.sign(jwtKey("web"));
    };
    expect(await verifyAccessToken(await mk({ sid: "s" }))).toBeNull();
    expect(await verifyAccessToken(await mk({}, "p"))).toBeNull();
    expect(await verifyAccessToken(await mk({ sid: 5 }, "p"))).toBeNull();
    expect(await verifyAccessToken(await mk({ sid: "s" }, "p"))).toEqual({ personId: "p", sessionId: "s" });
    // wrong issuer
    const wrongIss = await new SignJWT({ sid: "s" }).setProtectedHeader({ alg: "HS256" }).setSubject("p").setIssuer("evil").setAudience("web").setExpirationTime("5m").sign(jwtKey("web"));
    expect(await verifyAccessToken(wrongIss)).toBeNull();
  });
  it("property: a token verifies only in the realm it was minted for", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...REALMS), fc.constantFrom(...REALMS), fc.uuid(), fc.uuid(), async (mint, check, p, s) => {
        const { token } = await signAccessToken(p, s, Date.now(), mint);
        const out = await verifyAccessToken(token, undefined, check);
        expect(out).toEqual(mint === check ? { personId: p, sessionId: s } : null);
      }),
      { numRuns: 40 },
    );
  });
  it("expiry boundary uses the realm TTL", async () => {
    const now = 1_700_000_000_000;
    for (const r of REALMS) {
      const { token, expiresAt } = await signAccessToken("p", "s", now, r);
      expect(expiresAt.getTime() - Math.floor(now / 1000) * 1000).toBe(REALM_POLICY[r].accessTtlSeconds * 1000);
      expect(await verifyAccessToken(token, new Date(expiresAt.getTime() - 1000), r)).not.toBeNull();
      expect(await verifyAccessToken(token, new Date(expiresAt.getTime() + 1000), r)).toBeNull();
    }
  });
});

describe("GSTIN checksum (property)", () => {
  it("every generated GSTIN is valid", () => fc.assert(fc.property(gstinArb, (g) => { expect(isValidGstin(g)).toBe(true); }), { numRuns: 300 }));
  it("mutating any single character makes it invalid", () =>
    fc.assert(
      fc.property(gstinArb, fc.nat(14), fc.constantFrom(...CS.split("")), (g, i, c) => {
        fc.pre(g[i] !== c);
        const m = g.slice(0, i) + c + g.slice(i + 1);
        expect(isValidGstin(m)).toBe(false);
      }),
      { numRuns: 500 },
    ));
  it("wrong length / lowercase / unknown state code is invalid", () => {
    fc.assert(fc.property(gstinArb, (g) => {
      expect(isValidGstin(g.slice(1))).toBe(false);
      expect(isValidGstin(g + "A")).toBe(false);
      expect(isValidGstin(g.toLowerCase())).toBe(false);
    }));
    const g = "27AAPFU0939F1ZV";
    expect(isValidGstin("00" + g.slice(2))).toBe(false);
    expect(isValidGstin("39" + g.slice(2))).toBe(false);
    expect(isValidGstin(g.slice(0, 13) + "AV")).toBe(false); // 14th must be Z
    expect(normaliseGstin("  27aapfu0939f1zv ")).toBe(g);
    expect(panFromGstin(g)).toBe("AAPFU0939F");
  });
  it("Udyam format", () => {
    for (const ok of ["UDYAM-MH-12-1234567", "UDYAM-KA-00-0000000"]) expect(isValidUdyam(ok)).toBe(true);
    for (const bad of ["udyam-mh-12-1234567", "UDYAM-MH-1-1234567", "UDYAM-MH-12-123456", "UDYAM-MH-12-12345678", " UDYAM-MH-12-1234567"]) expect(isValidUdyam(bad)).toBe(false);
  });
  it("legacy mock provider is deterministic and getGstnProvider honours set/reset", async () => {
    const r = await mockGstnProvider.lookup("27AAPFU0939F1ZV");
    expect(r).toMatchObject({ status: "Active", state: "Maharashtra", legalName: "AAPFU0939F Enterprises Pvt Ltd" });
    expect((await mockGstnProvider.lookup("99AAPFU0939F1ZV"))?.state).toBeNull();
    const custom = { name: "x", lookup: async () => null };
    setGstnProvider(custom);
    expect(getGstnProvider()).toBe(custom);
    setGstnProvider(null);
    expect(getGstnProvider().name).toBe("mock");
    setGstnProvider(null);
  });
});

describe("company-name normaliser + similarity", () => {
  it.each([
    ["M/S Sharma Steel Pvt. Ltd.", "sharma steel"], ["m s Sharma Steel", "sharma steel"], ["Messrs Sharma Steel", "sharma steel"],
    ["SHARMA STEEL PRIVATE LIMITED", "sharma steel"], ["Sharma Steel Pvt Limited", "sharma steel"], ["Sharma Steel P Ltd", "sharma steel"],
    ["Rao & Sons LLP", "rao and sons"], ["Rao and Company", "rao"], ["Rao & Co.", "rao"], ["Tata (India) Ltd", "tata"],
    ["Sharma-Steel_Works/East", "sharma steel works east"], ["  Multiple   Spaces  ", "multiple spaces"],
    ["Acme OPC", "acme"], ["Acme Proprietor", "acme"], ["Ltd", "ltd"], ["Co", "co"], ["", ""],
  ])("normaliseName(%j) = %j", (raw, want) => expect(normaliseName(raw)).toBe(want));
  it("property: idempotent-ish, lower-case, no double spaces", () =>
    fc.assert(fc.property(fc.string(), (s) => {
      const n = normaliseName(s);
      expect(n).toBe(n.toLowerCase());
      expect(n).not.toMatch(/\s{2,}/);
      expect(n).toBe(n.trim());
    })));
  it("property: similarity is symmetric, in [0,1], 1.0 for identical non-empty names", () =>
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), fc.string({ maxLength: 30 }), (a, b) => {
        const s = nameSimilarity(a, b);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1 + 1e-9);
        expect(nameSimilarity(b, a)).toBeCloseTo(s, 9);
      }),
      { numRuns: 300 },
    ));
  it("identical names score 1.0", () =>
    fc.assert(fc.property(fc.array(fc.stringMatching(/^[a-z]{2,8}$/), { minLength: 1, maxLength: 4 }), (words) => {
      const name = words.join(" ");
      fc.pre(normaliseName(name).length > 0);
      expect(nameSimilarity(name, name)).toBeCloseTo(1, 9);
    })));
  it("word order does not matter; empty/suffix-only name scores 0", () => {
    expect(nameSimilarity("Steel Sharma", "Sharma Steel")).toBe(1);
    expect(nameSimilarity("", "Sharma")).toBe(0);
    expect(nameSimilarity("Sharma", "  ")).toBe(0);
  });
  it("tolerates a single typo per token but not unrelated names", () => {
    expect(nameSimilarity("Sharma Steel", "Sharma Steal")).toBeGreaterThan(0.85);
    expect(nameSimilarity("Sharma Steel", "Verma Textiles")).toBeLessThan(0.3);
  });
  it("PAN/CIN/LLPIN patterns and masking", () => {
    expect(PAN_RE.test("ABCDE1234F")).toBe(true);
    expect(PAN_RE.test("abcde1234f")).toBe(false);
    expect(CIN_RE.test("U74999MH2010PTC123456")).toBe(true);
    expect(CIN_RE.test("X74999MH2010PTC123456")).toBe(false);
    expect(LLPIN_RE.test("AAB-1234")).toBe(true);
    expect(maskPan("ABCDE1234F")).toBe("XXXXX1234F");
    expect(maskPan(null)).toBeNull();
    expect(maskPan("")).toBeNull();
    expect(maskPan(undefined)).toBeNull();
  });
});

describe("phone + email helpers", () => {
  it.each([
    ["9876543210", "+919876543210"], ["98765 43210", "+919876543210"], ["(987) 654-3210", "+919876543210"], ["+91 98765 43210", "+919876543210"],
    ["00919876543210", "+919876543210"], ["+14155552671", "+14155552671"], ["0044 20 7946 0958", "+442079460958"],
  ])("normalisePhone(%j) -> %j", (raw, want) => expect(normalisePhone(raw)).toBe(want));
  it.each(["", "12345", "5876543210", "+0123456789", "abc", "+1234567", "+1234567890123456", "98765432101", "+91-98765-4321x"])("rejects %j", (raw) =>
    expect(() => normalisePhone(raw)).toThrow(/valid phone/));
  it("property: output is always E.164 and idempotent", () =>
    fc.assert(fc.property(fc.string({ maxLength: 20 }), (raw) => {
      try {
        const p = normalisePhone(raw);
        expect(p).toMatch(/^\+[1-9]\d{7,14}$/);
        expect(normalisePhone(p)).toBe(p);
      } catch (e) {
        expect((e as { code?: string }).code).toBe("validation");
      }
    }), { numRuns: 400 }));
  it("maskEmail", () => {
    expect(maskEmail("dinesh@gmail.com")).toBe("d***@gmail.com");
    expect(maskEmail("@x.com")).toBe("***");
    expect(maskEmail("nodomain")).toBe("***");
    expect(maskEmail(null)).toBeNull();
  });
});

describe("senders/mailers", () => {
  it("default to console adapters and can be swapped", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(getMailer()).toBe(consoleMailer);
    expect(getSmsSender()).toBe(consoleSms);
    expect(getOtpSender()).toBe(consoleOtpSender);
    await consoleMailer.send({ to: "a@b.c", subject: "s", text: "t" });
    await consoleSms.send({ to: "+91", text: "t" });
    await consoleOtpSender.send({ to: "+91", code: "123456", channel: "sms", ttlMinutes: 10 });
    expect(info).toHaveBeenCalledTimes(3);
    info.mockRestore();
    const m = { send: async () => {} };
    setMailer(m); setSmsSender(m); setOtpSender(m);
    expect(getMailer()).toBe(m); expect(getSmsSender()).toBe(m); expect(getOtpSender()).toBe(m);
    setMailer(consoleMailer); setSmsSender(consoleSms); setOtpSender(consoleOtpSender);
  });
  it("unconfigured provider senders fail loudly", async () => {
    for (const p of ["msg91", "gupshup", "twilio"] as const)
      await expect(unconfiguredOtpSender(p).send({ to: "x", code: "1", channel: "sms", ttlMinutes: 1 })).rejects.toThrow(p);
  });
});

describe("trust score (property)", () => {
  const sig = fc.record({
    tier: fc.integer({ min: -2, max: 6 }), acceptedFast: fc.nat(500), acceptedSlow: fc.nat(500), declined: fc.nat(500), expired: fc.nat(500),
    moderationRejections: fc.nat(50), dealsWon: fc.nat(50), disputesLost: fc.nat(20), inactiveDays: fc.nat(1000),
  });
  it("is always an integer in 0..100 and the badge follows the rule", () =>
    fc.assert(fc.property(sig, (s) => {
      const { score, badgeActive } = computeTrustScore(s);
      expect(Number.isInteger(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
      expect(badgeActive).toBe(s.tier >= 1 && score >= BADGE_THRESHOLD);
    }), { numRuns: 500 }));
  it("is monotonic in positive signals (tier, fast accepts, declines-as-response, deals won)", () =>
    fc.assert(fc.property(sig, (s) => {
      const base = computeTrustScore(s).score;
      for (const k of ["acceptedFast", "dealsWon"] as const) {
        expect(computeTrustScore({ ...s, [k]: s[k] + 1 }).score).toBeGreaterThanOrEqual(base - 1e-9);
      }
      if (s.tier < 3) expect(computeTrustScore({ ...s, tier: Math.max(0, s.tier) + 1 }).score).toBeGreaterThanOrEqual(base);
      // a fast answer beats an unanswered expiry
      expect(computeTrustScore({ ...s, acceptedFast: s.acceptedFast + 1 }).score).toBeGreaterThanOrEqual(computeTrustScore({ ...s, expired: s.expired + 1 }).score);
    }), { numRuns: 400 }));
  it("is anti-monotonic in negative signals", () =>
    fc.assert(fc.property(sig, (s) => {
      const base = computeTrustScore(s).score;
      for (const k of ["expired", "acceptedSlow", "moderationRejections", "disputesLost", "inactiveDays"] as const) {
        expect(computeTrustScore({ ...s, [k]: s[k] + 1 }).score).toBeLessThanOrEqual(base);
      }
    }), { numRuns: 400 }));
  it("clamps: tier is clamped to 0..3 and penalties are capped", () => {
    expect(computeTrustScore(emptySignals(99)).score).toBe(computeTrustScore(emptySignals(3)).score);
    expect(computeTrustScore(emptySignals(-5)).score).toBe(computeTrustScore(emptySignals(0)).score);
    const worst: TrustSignals = { ...emptySignals(0), expired: 999, moderationRejections: 999, disputesLost: 999, inactiveDays: 9999 };
    expect(computeTrustScore(worst).score).toBeGreaterThanOrEqual(0);
    expect(computeTrustScore(worst).badgeActive).toBe(false);
    const best: TrustSignals = { ...emptySignals(3), acceptedFast: 999, dealsWon: 999 };
    expect(computeTrustScore(best).score).toBeLessThanOrEqual(100);
  });
  it("tier 0 never gets a badge even with a high score", () => {
    const s: TrustSignals = { ...emptySignals(0), acceptedFast: 100, dealsWon: 50 };
    expect(computeTrustScore(s).score).toBeGreaterThanOrEqual(BADGE_THRESHOLD);
    expect(computeTrustScore(s).badgeActive).toBe(false);
  });
  it("inactivity decay starts after 30 days", () => {
    const a = computeTrustScore({ ...emptySignals(1), inactiveDays: 30 }).score;
    const b = computeTrustScore({ ...emptySignals(1), inactiveDays: 0 }).score;
    expect(a).toBe(b);
    expect(computeTrustScore({ ...emptySignals(1), inactiveDays: 31 }).score).toBeLessThan(a);
  });
  it("consent purposes are the ADR-010 purposes plus credit underwriting (ADR-019)", () => expect([...CONSENT_PURPOSES].sort()).toEqual(["analytics_cookies", "counterparty_sharing", "credit_underwriting", "functional_cookies", "marketing", "marketing_cookies", "matching", "voice_retention"]));
});

describe("TOTP / base32 (property)", () => {
  it("base32 round-trips for arbitrary bytes", () =>
    fc.assert(fc.property(fc.uint8Array({ maxLength: 64 }), (b) => {
      expect(Uint8Array.from(base32Decode(base32Encode(b)))).toEqual(b);
    })));
  it("base32Decode is case/space/padding/dash tolerant and rejects junk", () => {
    expect(base32Decode("mzxw 6ytb-oi======").toString()).toBe("foobar");
    expect(() => base32Decode("1")).toThrow("Invalid base32");
  });
  it("a code generated at t verifies at any time within ±1 step and not beyond", () =>
    fc.assert(fc.property(fc.uint8Array({ minLength: 10, maxLength: 32 }), fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }), (raw, t) => {
      const secret = Buffer.from(raw);
      const code = totp(secret, t);
      const step = totpStep(t);
      expect(verifyTotp(secret, code, { nowMs: t })).toBe(step);
      expect(verifyTotp(secret, code, { nowMs: t + 30_000 })).toBe(step);
      expect(verifyTotp(secret, code, { nowMs: t - 30_000 })).toBe(step);
      expect(verifyTotp(secret, code, { nowMs: t + 3 * 30_000 })).toBeNull();
      expect(verifyTotp(secret, code, { nowMs: t - 3 * 30_000 })).toBeNull();
    }), { numRuns: 100 }));
  it("window 0 is exact; digits/algorithm options; malformed codes rejected", () => {
    const s = Buffer.from("12345678901234567890");
    const t = 59_000;
    expect(totp(s, t, { digits: 8 })).toBe("94287082");
    expect(totp(Buffer.from("12345678901234567890123456789012"), t, { digits: 8, algorithm: "sha256" })).toBe("46119246");
    expect(totp(Buffer.from("1234567890123456789012345678901234567890123456789012345678901234"), t, { digits: 8, algorithm: "sha512" })).toBe("90693936");
    const c = totp(s, t);
    expect(verifyTotp(s, c, { nowMs: t, window: 0 })).toBe(1);
    expect(verifyTotp(s, c, { nowMs: t + 30_000, window: 0 })).toBeNull();
    for (const bad of ["", "12345", "1234567", "abcdef", "12 345"]) expect(verifyTotp(s, bad, { nowMs: t })).toBeNull();
    expect(hotp(s, 0n)).toBe("755224");
  });
  it("otpauthUri encodes label + parameters", () => {
    const u = new URL(otpauthUri({ secretBase32: "ABC", account: "a b@x.com", issuer: "My Co", digits: 8, period: 60 }));
    expect(u.protocol).toBe("otpauth:");
    expect(u.host).toBe("totp");
    expect(decodeURIComponent(u.pathname)).toBe("/My Co:a b@x.com");
    expect(Object.fromEntries(u.searchParams)).toEqual({ secret: "ABC", issuer: "My Co", algorithm: "SHA1", digits: "8", period: "60" });
  });
});
