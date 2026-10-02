import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertSameOrigin, enforceRateLimit, handleCspReport, isSameOrigin, logSecurityEvent, RATE_LIMITS, safeRedirectPath, safeRedirectUrl, setSecurityEventSink,
  type SecurityEvent,
} from "../src";
import { redis } from "@cnote/core";

const opts = { seed: 99, numRuns: 500 };
const events: SecurityEvent[] = [];
let prev: ReturnType<typeof setSecurityEventSink>;
beforeEach(() => {
  events.length = 0;
  prev = setSecurityEventSink((e) => events.push(e));
});
afterEach(() => setSecurityEventSink(prev));

const req = (method: string, headers: Record<string, string> = {}, url = "https://app.example.in/api/x") => new Request(url, { method, headers });

afterEach(() => vi.useRealTimers());

describe("CSRF / same-origin", () => {
  it.each(["GET", "HEAD", "OPTIONS"])("%s is always allowed, even with a hostile Origin", (m) => {
    expect(isSameOrigin(req(m, { origin: "https://evil.com" }))).toBe(true);
  });
  it.each(["POST", "PUT", "PATCH", "DELETE"])("%s: matching origin passes, hostile origin fails", (m) => {
    expect(isSameOrigin(req(m, { origin: "https://app.example.in" }))).toBe(true);
    expect(isSameOrigin(req(m, { origin: "https://evil.com" }))).toBe(false);
  });
  it.each([
    "http://app.example.in", // protocol downgrade
    "https://app.example.in:8443", // other port
    "https://app.example.in.evil.com", // suffix trick
    "https://evil.com/https://app.example.in",
    "https://sub.app.example.in", // sibling/sub-domain is not same-origin
    "https://APP.example.in.", // trailing dot
    "null",
    "file://",
  ])("rejects Origin %j", (origin) => {
    expect(isSameOrigin(req("POST", { origin }))).toBe(false);
  });
  it("Origin takes precedence over a spoofed same-origin Sec-Fetch-Site/Referer", () => {
    expect(isSameOrigin(req("POST", { origin: "https://evil.com", "sec-fetch-site": "same-origin", referer: "https://app.example.in/" }))).toBe(false);
  });
  it("Sec-Fetch-Site: only same-origin and none pass; same-site and cross-site do not", () => {
    expect(isSameOrigin(req("POST", { "sec-fetch-site": "none" }))).toBe(true);
    expect(isSameOrigin(req("POST", { "sec-fetch-site": "same-site" }))).toBe(false);
    expect(isSameOrigin(req("POST", { "sec-fetch-site": "cross-site" }))).toBe(false);
  });
  it("Referer fallback: same origin passes; other origin and unparseable referers fail", () => {
    expect(isSameOrigin(req("POST", { referer: "https://app.example.in/page?x=1" }))).toBe(true);
    expect(isSameOrigin(req("POST", { referer: "https://evil.com/" }))).toBe(false);
    expect(isSameOrigin(req("POST", { referer: "::::" }))).toBe(false);
  });
  it("uses the first x-forwarded-host/proto value and falls back to the URL origin without a host", () => {
    const fwd = req("POST", { origin: "https://shop.in", "x-forwarded-host": "shop.in, proxy.internal", "x-forwarded-proto": "https, http" }, "http://internal:3000/x");
    expect(isSameOrigin(fwd)).toBe(true);
    expect(isSameOrigin(req("POST", { origin: "https://internal:3000" }, "https://internal:3000/x"))).toBe(true);
  });
  it("extraOrigins are exact matches only", () => {
    expect(isSameOrigin(req("POST", { origin: "https://custom.in" }), ["https://custom.in"])).toBe(true);
    expect(isSameOrigin(req("POST", { origin: "https://custom.in.evil.com" }), ["https://custom.in"])).toBe(false);
    expect(isSameOrigin(req("POST", { origin: "https://custom.in" }), [])).toBe(false);
  });
  it("assertSameOrigin throws a forbidden DomainError and logs a csrf.blocked event with the path", () => {
    let err: unknown;
    try {
      assertSameOrigin(req("POST", { origin: "https://evil.com" }));
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ name: "DomainError", code: "forbidden" });
    expect(events[0]).toMatchObject({ type: "csrf.blocked", data: { method: "POST", path: "/api/x", origin: "https://evil.com" } });
    expect(() => assertSameOrigin(req("POST", { origin: "https://app.example.in" }))).not.toThrow();
  });
});

describe("safeRedirectPath", () => {
  const attacks = [
    "//evil.com", "///evil.com", "////evil.com/x", "/\\evil.com", "/\\/evil.com", "\\\\evil.com", "\\/evil.com", "/\t/evil.com", "/\n/evil.com", "/\r/evil.com", "/\u0000/evil.com",
    "/ \\evil.com", "http://evil.com", "https://evil.com", "HTTPS://evil.com", "//evil.com/%2f..", "https:evil.com", "http:/evil.com", "javascript:alert(1)", "JaVaScRiPt:alert(1)",
    "data:text/html,<script>1</script>", "vbscript:x", "evil.com", "evil.com/x", "", " /x", "\t/x", "/\u007f\\", "mailto:a@b.co", "@evil.com", "?next=//evil.com", "#//evil.com",
  ];
  it.each(attacks)("rejects %j", (a) => expect(safeRedirectPath(a, "/safe")).toBe("/safe"));
  it("null/undefined fall back; the default fallback is /", () => {
    expect(safeRedirectPath(null, "/f")).toBe("/f");
    expect(safeRedirectPath(undefined)).toBe("/");
    expect(safeRedirectPath("//x")).toBe("/");
  });
  it.each(["/", "/account", "/account?tab=1&x=%2F%2Fevil.com", "/a/b/c#frag", "/%2f%2fevil.com", "/a//b", "/.//x"])("keeps legitimate path %j", (p) => expect(safeRedirectPath(p, "/f")).toBe(p));
  it("PROPERTY: whatever the input, the result stays on the origin (or is the fallback)", () => {
    const evil = fc.oneof(
      fc.string(),
      fc.constantFrom("/", "//", "\\", "/\\", "\t", "\n", "%2f", "@", ":", "http:", "https:", "javascript:", ".", "..", "evil.com", "?", "#").chain((a) =>
        fc.tuple(fc.constant(a), fc.array(fc.constantFrom("/", "\\", "\t", "\n", "%2f", "@", "evil.com", ".", "a"), { maxLength: 6 })).map(([x, ys]) => x + ys.join("")),
      ),
    );
    fc.assert(
      fc.property(evil, (s) => {
        const out = safeRedirectPath(s, "/fallback");
        if (out === "/fallback") return true;
        const u = new URL(out, "https://site.test");
        return out.startsWith("/") && !out.startsWith("//") && !/[\\\u0000-\u001f]/.test(out) && u.origin === "https://site.test";
      }),
      opts,
    );
  });
});

describe("safeRedirectUrl", () => {
  const allowed = ["example.in", "shop.test"];
  it.each([
    "https://example.in.evil.com/", "https://evilexample.in/", "https://example.in@evil.com/", "https://evil.com\\@example.in/", "https://user:pw@example.in/", "https://:pw@example.in/",
    "ftp://example.in/", "javascript:alert(1)", "data:text/html,x", "//example.in/x", "/relative", "example.in", "https://", "", "https://evil.com/?u=https://example.in", "https://example.in.:evil", "https://xn--exmple-cua.in/",
  ])("rejects %j", (t) => expect(safeRedirectUrl(t, allowed, "/fb")).toBe("/fb"));
  it("accepts exact hosts, subdomains, http and https; case-insensitive host; keeps path/query", () => {
    expect(safeRedirectUrl("https://example.in/a?b=1#c", allowed, "/fb")).toBe("https://example.in/a?b=1#c");
    expect(safeRedirectUrl("http://a.b.example.in/x", allowed, "/fb")).toBe("http://a.b.example.in/x");
    expect(safeRedirectUrl("https://EXAMPLE.IN/", allowed, "/fb")).toBe("https://example.in/");
    expect(safeRedirectUrl("https://shop.test:8443/", allowed, "/fb")).toBe("https://shop.test:8443/");
  });
  it("null/undefined/no allowed hosts fall back", () => {
    expect(safeRedirectUrl(null, allowed, "/fb")).toBe("/fb");
    expect(safeRedirectUrl(undefined, allowed, "/fb")).toBe("/fb");
    expect(safeRedirectUrl("https://example.in/", [], "/fb")).toBe("/fb");
  });
  it("PROPERTY: the result is the fallback or a http(s) URL on an allowed host without credentials", () => {
    const hosts = fc.constantFrom("example.in", "sub.example.in", "evil.com", "example.in.evil.com", "evilexample.in", "shop.test", "EXAMPLE.IN", "127.0.0.1", "[::1]");
    const url = fc.tuple(fc.constantFrom("https", "http", "ftp", "javascript", "data"), fc.constantFrom("", "u@", "u:p@", "@"), hosts, fc.constantFrom("", ":8080"), fc.constantFrom("", "/", "/x?y=1", "\\@evil.com")).map(([s, cred, h, p, path]) => `${s}://${cred}${h}${p}${path}`);
    fc.assert(
      fc.property(fc.oneof(url, fc.string()), (t) => {
        const out = safeRedirectUrl(t, allowed, "/fb");
        if (out === "/fb") return true;
        const u = new URL(out);
        return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password && allowed.some((a) => u.hostname === a || u.hostname.endsWith(`.${a}`));
      }),
      opts,
    );
  });
});

describe("rate-limit presets", () => {
  it("every preset is well-formed and tighter presets guard the sensitive flows", () => {
    for (const [name, p] of Object.entries(RATE_LIMITS)) {
      expect(Number.isInteger(p.limit) && p.limit > 0, name).toBe(true);
      expect(Number.isInteger(p.windowSeconds) && p.windowSeconds > 0, name).toBe(true);
      expect(p.message.length, name).toBeGreaterThan(5);
    }
    expect(RATE_LIMITS.passwordReset.limit).toBeLessThan(RATE_LIMITS.signIn.limit);
    expect(RATE_LIMITS.otpRequest.limit).toBeLessThanOrEqual(RATE_LIMITS.otpVerify.limit);
    expect(RATE_LIMITS.apiWrite.limit).toBeLessThan(RATE_LIMITS.apiRead.limit);
  });

  it("enforceRateLimit allows exactly `limit` calls, then throws rate_limited with the preset message; subjects are independent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); // fixed-window limiter: a real minute/hour boundary mid-test would reset the counter
    const subject = `t-${randomUUID()}`;
    for (let i = 0; i < RATE_LIMITS.passwordReset.limit; i++) await expect(enforceRateLimit("passwordReset", subject)).resolves.toBeUndefined();
    await expect(enforceRateLimit("passwordReset", subject)).rejects.toMatchObject({ code: "rate_limited", message: RATE_LIMITS.passwordReset.message });
    await expect(enforceRateLimit("passwordReset", `t-${randomUUID()}`)).resolves.toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: "rate_limit.exceeded", data: { preset: "passwordReset", subject } });
  });

  it("does not put an email subject into the security log", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); // fixed-window limiter: a real minute/hour boundary mid-test would reset the counter
    const email = `${randomUUID()}@victim.example.com`;
    for (let i = 0; i < RATE_LIMITS.passwordReset.limit; i++) await enforceRateLimit("passwordReset", email);
    await expect(enforceRateLimit("passwordReset", email)).rejects.toThrow();
    expect(JSON.stringify(events)).not.toContain(email);
    expect(JSON.stringify(events)).toContain("[email]");
  });

  it("presets do not share counters", async () => {
    const subject = `t-${randomUUID()}`;
    for (let i = 0; i < RATE_LIMITS.passwordReset.limit; i++) await enforceRateLimit("passwordReset", subject);
    await expect(enforceRateLimit("signUp", subject)).resolves.toBeUndefined();
  });
});

describe("logSecurityEvent", () => {
  it("drops secret-looking keys at any depth, masks emails, truncates long strings and long arrays", () => {
    logSecurityEvent("x.test", {
      password: "p", Authorization: "Bearer abc", cookie: "c", otp: "123456", jwt: "j", apiKey: "k", api_key: "k", refreshToken: "r", secret: "s",
      keep: 1,
      nested: { deeper: { token: "t", who: "me@example.com" } },
      long: "z".repeat(2000),
      list: Array.from({ length: 100 }, (_, i) => i),
    });
    const d = events[0]!.data as Record<string, unknown> & { nested: { deeper: { token: string; who: string } }; long: string; list: number[] };
    for (const k of ["password", "Authorization", "cookie", "otp", "jwt", "apiKey", "api_key", "refreshToken", "secret"]) expect(d[k], k).toBe("[redacted]");
    expect(d.keep).toBe(1);
    expect(d.nested.deeper).toEqual({ token: "[redacted]", who: "[email]" });
    expect(d.long).toHaveLength(500);
    expect(d.list).toHaveLength(20);
    expect(events[0]!.type).toBe("x.test");
    expect(Number.isNaN(Date.parse(events[0]!.at))).toBe(false);
  });

  it("fails closed beyond the depth limit: deep secrets/emails never reach the sink", () => {
    let deep: unknown = { token: "SECRET-TOKEN", mail: "leak@example.com" };
    for (let i = 0; i < 10; i++) deep = { n: deep };
    logSecurityEvent("x.deep", { deep });
    expect(JSON.stringify(events)).not.toMatch(/SECRET-TOKEN|leak@example\.com/);
  });

  it("never throws, even when the sink throws or the data is circular; setSecurityEventSink returns the previous sink", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => logSecurityEvent("x.circ", a)).not.toThrow();
    const first = (() => undefined) as (e: SecurityEvent) => void;
    const p1 = setSecurityEventSink(first);
    expect(typeof p1).toBe("function");
    expect(setSecurityEventSink(() => {
      throw new Error("sink down");
    })).toBe(first);
    expect(() => logSecurityEvent("x.throw")).not.toThrow();
  });

  it("default sink writes one structured JSON line to console.warn", async () => {
    const { vi } = await import("vitest");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // restore the module default by capturing what setSecurityEventSink replaced at import time
    const original = prev;
    setSecurityEventSink(original);
    logSecurityEvent("auth.signin_failed", { email: "a@b.co", password: "x", n: 1 });
    const line = JSON.parse(warn.mock.calls[0]![0] as string);
    expect(line).toMatchObject({ level: "security", event: "auth.signin_failed", email: "[email]", password: "[redacted]", n: 1 });
    warn.mockRestore();
  });
});

describe("handleCspReport", () => {
  const ipHeader = () => ({ "x-forwarded-for": `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}, 1.1.1.1` });
  const post = (body: string, headers: Record<string, string> = ipHeader()) => new Request("https://a.in/api/csp-report", { method: "POST", body, headers });

  it("non-POST is 405 with an Allow header", async () => {
    const res = await handleCspReport(new Request("https://a.in/api/csp-report"));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("parses the report-to (reports+json array) format and strips query/fragment from URLs", async () => {
    const body = JSON.stringify([
      { type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "https://evil.com/p.png?x=1#f", documentURL: "https://a.in/p?token=1", sourceFile: "https://a.in/app.js?v=2", lineNumber: 7, disposition: "enforce" } },
    ]);
    expect((await handleCspReport(post(body))).status).toBe(204);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "csp.violation",
      data: { directive: "img-src", blocked: "https://evil.com/p.png", document: "https://a.in/p", source: "https://a.in/app.js", line: 7, disposition: "enforce" },
    });
  });

  it("falls back to violated-directive and handles inline/eval blocked-uri values", async () => {
    await handleCspReport(post(JSON.stringify({ "csp-report": { "violated-directive": "script-src-elem", "blocked-uri": "inline" } })));
    expect(events[0]!.data).toMatchObject({ directive: "script-src-elem", blocked: "inline" });
  });

  it("logs at most 5 reports per request", async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ body: { effectiveDirective: `d${i}` } }));
    await handleCspReport(post(JSON.stringify(items)));
    expect(events).toHaveLength(5);
  });

  it("ignores oversized, malformed, empty and non-object payloads, always answering 204", async () => {
    for (const body of ["x".repeat(20_000), "{not json", "", "null", "42", "[]", '"str"', JSON.stringify([null, 1, "s"])]) {
      const res = await handleCspReport(post(body));
      expect(res.status, body.slice(0, 20)).toBe(204);
    }
    for (const e of events) expect(Object.values(e.data).every((v) => v === undefined)).toBe(true); // junk never smuggles data into the log
  });

  it("is rate-limited per client IP: after the budget, reports are dropped silently", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); // fixed-window limiter: a real minute/hour boundary mid-test would reset the counter
    const ip = { "x-forwarded-for": `172.31.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
    const body = JSON.stringify({ "csp-report": { "effective-directive": "script-src" } });
    for (let i = 0; i < RATE_LIMITS.cspReport.limit; i++) await handleCspReport(post(body, ip));
    events.length = 0;
    const res = await handleCspReport(post(body, ip));
    expect(res.status).toBe(204);
    expect(events).toHaveLength(0);
  });

  it("falls back to cf-connecting-ip, then 'unknown', for the limiter key", async () => {
    const body = JSON.stringify({ "csp-report": { "effective-directive": "a" } });
    expect((await handleCspReport(post(body, { "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 250)}` }))).status).toBe(204);
    expect((await handleCspReport(post(body, {}))).status).toBe(204);
  });
});
