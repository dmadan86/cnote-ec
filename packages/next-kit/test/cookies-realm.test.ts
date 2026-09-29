import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessCookie, clearAuthCookies, jwtExp, oauthCookieName, refreshCookie, safeNext, setAuthCookies } from "../src/cookies";
import { appRealm, realmCookies, realmPolicy } from "../src/realm";

const tokens = (over: Record<string, unknown> = {}) =>
  ({ accessToken: "AT", refreshToken: "RT", accessExpiresAt: new Date(), refreshExpiresAt: new Date(Date.now() + 3600_000), personId: "p", ...over }) as never;

beforeEach(() => vi.stubEnv("CNOTE_AUTH_REALM", "web"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("realm", () => {
  it.each(["web", "seller", "admin"])("accepts %s", (r) => {
    vi.stubEnv("CNOTE_AUTH_REALM", r);
    expect(appRealm()).toBe(r);
  });
  it.each(["", "root", "WEB", "undefined"])("rejects %j", (r) => {
    vi.stubEnv("CNOTE_AUTH_REALM", r);
    expect(() => appRealm()).toThrow(/CNOTE_AUTH_REALM/);
  });
  it("throws when unset", () => {
    vi.stubEnv("CNOTE_AUTH_REALM", undefined as never);
    delete process.env.CNOTE_AUTH_REALM;
    expect(() => appRealm()).toThrow();
  });
  it("admin has a shorter access TTL and 12h refresh cap", () => {
    vi.stubEnv("CNOTE_AUTH_REALM", "admin");
    expect(realmPolicy().accessTtlSeconds).toBeLessThan(15 * 60);
    expect(realmPolicy().refreshTtlSeconds).toBe(12 * 3600);
  });
});

describe("cookies per realm", () => {
  it("names differ per realm and never collide", () => {
    const seen = new Set<string>();
    for (const r of ["web", "seller", "admin"]) {
      vi.stubEnv("CNOTE_AUTH_REALM", r);
      const n = realmCookies();
      expect(n.access).toContain(r);
      seen.add(n.access);
      seen.add(n.refresh);
      seen.add(oauthCookieName());
    }
    expect(seen.size).toBe(9);
  });
  it("uses __Host- and Secure in production, plain and non-secure in dev", () => {
    expect(accessCookie(tokens()).name.startsWith("__Host-")).toBe(false);
    expect(accessCookie(tokens()).secure).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    const a = accessCookie(tokens());
    expect(a.name).toBe("__Host-cnote_web_at");
    expect(a.secure).toBe(true);
    expect(a.path).toBe("/");
    expect(a.httpOnly).toBe(true);
    expect(a.sameSite).toBe("lax");
    expect(refreshCookie(tokens()).name).toBe("__Host-cnote_web_rt");
  });
  it("access maxAge follows the realm policy", () => {
    vi.stubEnv("CNOTE_AUTH_REALM", "admin");
    expect(accessCookie(tokens()).maxAge).toBe(realmPolicy().accessTtlSeconds);
  });
  it("refresh maxAge is time to refreshExpiresAt, clamped at 0", () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
    expect(refreshCookie(tokens({ refreshExpiresAt: new Date("2026-01-01T12:00:00Z") })).maxAge).toBe(12 * 3600);
    expect(refreshCookie(tokens({ refreshExpiresAt: new Date("2025-12-31T00:00:00Z") })).maxAge).toBe(0);
    expect(refreshCookie(tokens({ refreshExpiresAt: "2026-01-01T00:00:10.9Z" })).maxAge).toBe(10);
  });
  it("set/clear write both cookies", () => {
    const set = vi.fn();
    const del = vi.fn();
    setAuthCookies({ set, delete: del }, tokens());
    expect(set.mock.calls.map((c) => c[0].name)).toEqual(["cnote_web_at", "cnote_web_rt"]);
    expect(set.mock.calls[0]![0]!.value).toBe("AT");
    clearAuthCookies({ set, delete: del });
    expect(del.mock.calls.map((c) => c[0])).toEqual(["cnote_web_at", "cnote_web_rt"]);
  });
});

const corpus = [
  "//evil.com", "///evil.com", "/\\evil.com", "\\evil.com", "\\\\evil.com", "/\t/evil.com", "/\n/evil.com", "/\r/evil.com", "/\u0000/evil",
  "https://evil.com", "http://evil.com", "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", " //evil.com", "evil.com", "@evil.com",
  "//\u3002evil.com", "mailto:a@b.c", "vbscript:x", "/\\/evil.com", "\u0000/x", "///", "http:evil.com",
];
describe("safeNext open-redirect corpus", () => {
  it.each(corpus)("rejects %j", (v) => expect(safeNext(v, "/fb")).toBe("/fb"));
  it("keeps legitimate paths, queries and hashes", () => {
    for (const p of ["/", "/a/b?x=1&y=2", "/search?q=//evil.com", "/a#frag", "/%2F%2Fevil.com", "/café"]) expect(safeNext(p)).toBe(p);
  });
  it("property: result is always the fallback or a same-origin-relative path", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = safeNext(s, "/fb");
        if (out === "/fb") return true;
        const u = new URL(out, "http://local.invalid");
        return u.origin === "http://local.invalid" && !out.startsWith("//") && !/[\\\u0000-\u001f]/.test(out);
      }),
      { numRuns: 500 },
    );
  });
  it("property: never accepts a value starting with a non-slash", () => {
    fc.assert(fc.property(fc.string({ minLength: 1 }).filter((s) => !s.startsWith("/")), (s) => safeNext(s, "/fb") === "/fb"));
  });
});

describe("jwtExp", () => {
  const tok = (p: unknown) => `h.${Buffer.from(typeof p === "string" ? p : JSON.stringify(p)).toString("base64url")}.s`;
  it("returns null for non-numeric exp, bad JSON, missing segment", () => {
    expect(jwtExp(tok({ exp: "1" }))).toBeNull();
    expect(jwtExp(tok({}))).toBeNull();
    expect(jwtExp(tok("not json"))).toBeNull();
    expect(jwtExp("onlyone")).toBeNull();
    expect(jwtExp("")).toBeNull();
  });
  it("property: roundtrips any numeric exp", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 4e9 }), (n) => jwtExp(tok({ exp: n })) === n));
  });
});
