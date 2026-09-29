import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { scrub, scrubEvent, scrubString } from "../src";

const opts = { seed: 20260929, numRuns: 400 };
const digit = fc.constantFrom(..."0123456789".split(""));
const digits = (n: number) => fc.array(digit, { minLength: n, maxLength: n }).map((a) => a.join(""));
const upper = fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""));
const letters = (n: number) => fc.array(upper, { minLength: n, maxLength: n }).map((a) => a.join(""));
const alnumUp = fc.constantFrom(..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""));
const nonZeroAlnum = fc.constantFrom(..."123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""));
const sep = fc.constantFrom(" ", ",", ":", ";", " - ", "\n", "(", ")", "=", '"');
const wrap = (pii: fc.Arbitrary<string>) =>
  fc.tuple(fc.string({ maxLength: 12 }).filter((s) => !/[\w@.+-]$/.test(s)), sep, pii, sep, fc.string({ maxLength: 12 }).filter((s) => !/^[\w@.+-]/.test(s)));

const mobileCore = fc.tuple(fc.constantFrom(..."6789".split("")), digits(9)).map(([a, b]) => a + b);
const mobile = fc
  .tuple(mobileCore, fc.constantFrom("", "+91", "+91 ", "+91-", "91", "91 ", "0"), fc.constantFrom("", " ", "-"))
  .map(([m, pre, mid]) => `${pre}${m.slice(0, 5)}${mid}${m.slice(5)}`);
const email = fc.emailAddress().filter((e) => /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(e));
const pan = fc.tuple(letters(5), digits(4), upper).map((p) => p.join(""));
const gstin = fc.tuple(digits(2), letters(5), digits(4), upper, nonZeroAlnum, alnumUp).map(([a, b, c, d, e, f]) => `${a}${b}${c}${d}${e}Z${f}`);
const aadhaar = fc
  .tuple(fc.constantFrom(..."23456789".split("")), digits(3), digits(4), digits(4), fc.constantFrom("", " ", "-"))
  .map(([a, b, c, d, s]) => `${a}${b}${s}${c}${s}${d}`);

describe("scrubString: no Indian PII survives (property)", () => {
  it("mobile numbers in every common format", () => {
    fc.assert(
      fc.property(wrap(mobile), ([pre, s1, pii, s2, post]) => {
        const out = scrubString(`${pre}${s1}${pii}${s2}${post}`);
        const core = pii.replace(/\D/g, "").slice(-10);
        expect(out.replace(/\D/g, "")).not.toContain(core);
        expect(out).toMatch(/\[(phone|aadhaar)\]/);
      }),
      opts,
    );
  });
  it("email addresses", () => {
    fc.assert(
      fc.property(wrap(email), ([pre, s1, pii, s2, post]) => {
        expect(scrubString(`${pre}${s1}${pii}${s2}${post}`)).not.toContain(pii);
      }),
      opts,
    );
  });
  it("PAN", () => {
    fc.assert(
      fc.property(wrap(pan), ([pre, s1, pii, s2, post]) => {
        expect(scrubString(`${pre}${s1}${pii}${s2}${post}`)).not.toContain(pii);
      }),
      opts,
    );
  });
  it("lowercase PAN / GSTIN typed by users", () => {
    fc.assert(
      fc.property(pan, gstin, (p, g) => {
        const out = scrubString(`pan ${p.toLowerCase()} gst ${g.toLowerCase()}`);
        expect(out).not.toContain(p.toLowerCase());
        expect(out).not.toContain(g.toLowerCase());
      }),
      opts,
    );
  });
  it("GSTIN (whole, including its embedded PAN)", () => {
    fc.assert(
      fc.property(wrap(gstin), ([pre, s1, pii, s2, post]) => {
        const out = scrubString(`${pre}${s1}${pii}${s2}${post}`);
        expect(out).not.toContain(pii);
        expect(out).not.toContain(pii.slice(2, 12));
      }),
      opts,
    );
  });
  it("Aadhaar (plain, space- and dash-separated)", () => {
    fc.assert(
      fc.property(wrap(aadhaar), ([pre, s1, pii, s2, post]) => {
        const out = scrubString(`${pre}${s1}${pii}${s2}${post}`);
        expect(out.replace(/\D/g, "")).not.toContain(pii.replace(/\D/g, ""));
      }),
      opts,
    );
  });
  it("is idempotent, and text without PII is untouched", () => {
    fc.assert(fc.property(fc.string(), (s) => scrubString(scrubString(s)) === scrubString(s)), opts);
    for (const s of ["", "hello world", "order #12345", "price ₹1,999 only", "v1.2.3", "2026-09-29T10:00:00Z", "12345"]) expect(scrubString(s)).toBe(s);
  });
});

describe("scrub: structure", () => {
  it("masks PII inside arbitrarily nested objects/arrays and preserves shape", () => {
    fc.assert(
      fc.property(mobile, email, (m, e) => {
        const out = scrub({ a: [{ b: { c: [`x ${m} y`] } }], d: { e: `mail ${e}.` }, n: 5, t: true, z: null }) as never as {
          a: [{ b: { c: string[] } }];
          d: { e: string };
          n: number;
          t: boolean;
          z: null;
        };
        expect(out.a[0].b.c[0]).not.toContain(m.replace(/\D/g, "").slice(-5));
        expect(out.d.e).not.toContain(e);
        expect([out.n, out.t, out.z]).toEqual([5, true, null]);
      }),
      opts,
    );
  });

  it("redacts every secret-looking key regardless of case or value type", () => {
    const keys = ["password", "Password", "PASSWD_HASH", "passphrase", "accessToken", "id_token", "CLIENT_SECRET", "Authorization", "cookie", "Set-Cookie", "otp", "code_verifier", "refresh_token", "jwt", "api_key", "apiKey", "API-KEY"];
    for (const k of keys) {
      for (const v of ["x", 1, { a: 1 }, ["y"], null, undefined, false]) expect(scrub({ [k]: v }), k).toEqual({ [k]: "[redacted]" });
    }
  });

  it("does not redact ordinary keys", () => {
    expect(scrub({ name: "n", listingId: "l", count: 2 })).toEqual({ name: "n", listingId: "l", count: 2 });
  });

  it("never mutates its input", () => {
    const input = { a: "call 9876543210", b: { password: "p", list: ["a@b.co"] } };
    const snapshot = structuredClone(input);
    scrub(input);
    expect(input).toEqual(snapshot);
  });

  it("passes through primitives, null and undefined", () => {
    expect(scrub(null)).toBeNull();
    expect(scrub(undefined)).toBeUndefined();
    expect(scrub(42)).toBe(42);
    expect(scrub(false)).toBe(false);
    expect(scrub("")).toBe("");
    expect(scrub("9876543210")).toBe("[phone]");
  });

  it("fails closed beyond the depth limit: deep PII is never emitted", () => {
    let deep: unknown = "reach me at 9876543210 or boss@corp.in";
    for (let i = 0; i < 20; i++) deep = { n: deep };
    expect(JSON.stringify(scrub(deep))).not.toMatch(/9876543210|boss@corp\.in/);
    let deepArr: unknown = "ABCDE1234F";
    for (let i = 0; i < 20; i++) deepArr = [deepArr];
    expect(JSON.stringify(scrub(deepArr))).not.toContain("ABCDE1234F");
  });

  it("terminates on circular structures without leaking", () => {
    const a: Record<string, unknown> = { s: "9876543210" };
    a.self = a;
    expect(JSON.stringify(scrub(a))).not.toContain("9876543210");
  });
});

describe("scrubEvent", () => {
  it("drops cookies, body, non-allowlisted headers; scrubs referer; keeps only opaque user id", () => {
    const e = scrubEvent({
      user: { id: 7, email: "a@b.co", username: "raj", ip_address: "1.1.1.1" },
      request: {
        cookies: { a: "b" },
        data: { phone: "9876543210" },
        headers: { cookie: "c", authorization: "Bearer x", "x-forwarded-for": "1.1.1.1", "user-agent": "UA", referer: "https://x.in/?e=a@b.co" },
      },
      message: "failed for 9876543210",
    });
    expect(e.user).toEqual({ id: 7 });
    expect(e.request).toEqual({ headers: { "user-agent": "UA", referer: "https://x.in/?e=[email]" } });
    expect(e.message).toBe("failed for [phone]");
  });
  it("user without an id is reduced to empty; user id 0 is kept", () => {
    expect(scrubEvent({ user: { email: "a@b.co", ip_address: "1.1.1.1" } }).user).toEqual({});
    expect(scrubEvent({ user: { id: 0, email: "a@b.co" } }).user).toEqual({ id: 0 });
  });
  it("handles events with no request/user and headers without allowlisted keys", () => {
    expect(scrubEvent({ level: "error" })).toEqual({ level: "error" });
    expect(scrubEvent({ request: { headers: { cookie: "x" } } }).request).toEqual({ headers: {} });
    expect(scrubEvent({ request: {} }).request).toEqual({});
  });
  it("redacts secret-keyed extras and breadcrumbs anywhere in the event", () => {
    const e = scrubEvent({ extra: { token: "t", ok: 1 }, breadcrumbs: [{ data: { authorization: "a", note: "9876543210" } }] });
    expect(e).toEqual({ extra: { token: "[redacted]", ok: 1 }, breadcrumbs: [{ data: { authorization: "[redacted]", note: "[phone]" } }] });
  });
});

describe("scrubString: regressions", () => {
  it("masks 0- and +91-prefixed mobiles written without a separator", () => {
    expect(scrubString("call 09876543210 now")).toBe("call [phone] now");
    expect(scrubString("call +919876543210 now")).toBe("call [phone] now");
    expect(scrubString("call 919876543210 now")).toBe("call [phone] now");
    expect(scrubString("call +91-98765-43210 now")).toBe("call [phone] now");
  });
  it("masks dash-separated Aadhaar and lowercase PAN/GSTIN", () => {
    expect(scrubString("uid 2345-6789-0123")).toBe("uid [aadhaar]");
    expect(scrubString("pan abcde1234f")).toBe("pan [pan]");
    expect(scrubString("gst 27aapfu0939f1zv")).toBe("gst [gstin]");
  });
  it("does not mask ordinary numbers that merely resemble PII", () => {
    expect(scrubString("id 1234567890123456")).toBe("id 1234567890123456");
    expect(scrubString("5 items @ 199.00")).toBe("5 items @ 199.00");
  });
  it("depth-limited values become [truncated] rather than leaking", () => {
    let deep: unknown = { pii: "9876543210" };
    for (let i = 0; i < 9; i++) deep = { n: deep };
    expect(JSON.stringify(scrub(deep))).toContain("[truncated]");
  });
});
