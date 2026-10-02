import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPublicHttpUrl, assertRequiredSecrets, assertSameOrigin, getHumanVerifier, handleCspReport, isPrivateAddress, isSameOrigin,
  logSecurityEvent, safeRedirectPath, safeRedirectUrl, setHumanVerifier, setSecurityEventSink, turnstileAdapter, validateSecrets, verifyHuman,
} from "../src";

afterEach(() => setHumanVerifier(null));

const post = (headers: Record<string, string>) => new Request("https://app.example.in/api/x", { method: "POST", headers });

describe("same origin", () => {
  it("allows safe methods, same origin, and header-less non-browser clients", () => {
    expect(isSameOrigin(new Request("https://a.in/x"))).toBe(true);
    expect(isSameOrigin(post({ origin: "https://app.example.in" }))).toBe(true);
    expect(isSameOrigin(post({}))).toBe(true);
    expect(isSameOrigin(post({ "sec-fetch-site": "same-origin" }))).toBe(true);
  });
  it("blocks cross-site", () => {
    expect(isSameOrigin(post({ origin: "https://evil.com" }))).toBe(false);
    expect(isSameOrigin(post({ origin: "null" }))).toBe(false);
    expect(isSameOrigin(post({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOrigin(post({ referer: "https://evil.com/p" }))).toBe(false);
    setSecurityEventSink(() => undefined);
    expect(() => assertSameOrigin(post({ origin: "https://evil.com" }))).toThrow("Cross-site");
  });
  it("honours forwarded host and extra origins", () => {
    const r = new Request("http://internal:3000/x", { method: "POST", headers: { origin: "https://shop.in", "x-forwarded-host": "shop.in", "x-forwarded-proto": "https" } });
    expect(isSameOrigin(r)).toBe(true);
    expect(isSameOrigin(post({ origin: "https://custom.in" }), ["https://custom.in"])).toBe(true);
  });
});

describe("redirects", () => {
  it("path validator", () => {
    for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "/a\nb", ""]) expect(safeRedirectPath(bad, "/f")).toBe("/f");
    expect(safeRedirectPath("/account?x=1")).toBe("/account?x=1");
  });
  it("url validator", () => {
    expect(safeRedirectUrl("https://shop.example.in/p", ["example.in"], "/")).toBe("https://shop.example.in/p");
    expect(safeRedirectUrl("https://example.in.evil.com", ["example.in"], "/")).toBe("/");
    expect(safeRedirectUrl("https://u:p@example.in", ["example.in"], "/")).toBe("/");
    expect(safeRedirectUrl("javascript:1", ["example.in"], "/")).toBe("/");
  });
});

describe("human verification", () => {
  it("dev adapter passes outside production, fails closed in production", async () => {
    expect((await getHumanVerifier({ NODE_ENV: "development" }).verify("x")).ok).toBe(true);
    expect(await getHumanVerifier({ NODE_ENV: "production" }).verify("x")).toEqual({ ok: false, reason: "not_configured" });
    expect((await getHumanVerifier({ NODE_ENV: "production", HUMAN_VERIFIER: "off" }).verify(null)).ok).toBe(true);
  });
  it("turnstile adapter posts secret/response/ip and maps results", async () => {
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      return Response.json(body.get("response") === "good" ? { success: true } : { success: false, "error-codes": ["invalid-input-response"] });
    });
    const v = turnstileAdapter("s3cret", f as unknown as typeof fetch);
    expect(await v.verify("good", "1.2.3.4")).toEqual({ ok: true });
    expect(await v.verify("bad")).toEqual({ ok: false, reason: "invalid-input-response" });
    expect(await v.verify("")).toEqual({ ok: false, reason: "missing_token" });
    const body = f.mock.calls[0]![1]!.body as URLSearchParams;
    expect(body.get("secret")).toBe("s3cret");
    expect(body.get("remoteip")).toBe("1.2.3.4");
    const down = turnstileAdapter("s", (async () => { throw new Error("net"); }) as unknown as typeof fetch);
    expect(await down.verify("t")).toEqual({ ok: false, reason: "provider_unreachable" });
  });
  it("verifyHuman uses the override", async () => {
    setHumanVerifier({ name: "t", verify: async (t) => (t === "ok" ? { ok: true } : { ok: false, reason: "no" }) });
    expect((await verifyHuman("ok")).ok).toBe(true);
    expect((await verifyHuman("nope")).ok).toBe(false);
  });
});

describe("secrets validator", () => {
  const good = () => ({
    NODE_ENV: "production",
    DATABASE_URL: "postgres://x/db?sslmode=require",
    REDIS_URL: "rediss://x",
    JWT_SECRET_WEB: "Zq8vK3mPx7Ld0Rt5YhNc2WbGe9UfAj4S1oXi6",
    FIELD_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString("base64")}`,
    BLIND_INDEX_KEY: Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz").toString("base64"),
    TURNSTILE_SECRET: "t",
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: "s",
  });
  it("passes a good production config", () => {
    expect(validateSecrets("web", good()).errors).toEqual([]);
  });
  it("flags missing and weak secrets in production", () => {
    const r = validateSecrets("web", { NODE_ENV: "production", JWT_SECRET: "dev-only-insecure-jwt-secret-change-me-please-0123456789" });
    expect(r.errors.join("\n")).toMatch(/weak/);
    expect(r.errors.join("\n")).toMatch(/FIELD_ENCRYPTION_KEYS/);
    expect(r.errors.join("\n")).toMatch(/BLIND_INDEX_KEY/);
    expect(() => assertRequiredSecrets("web", { NODE_ENV: "production" })).toThrow(/Refusing to start/);
  });
  it("requires distinct realm secrets", () => {
    const s = "Zq8vK3mPx7Ld0Rt5YhNc2WbGe9UfAj4S1oXi6";
    const r = validateSecrets("admin", { ...good(), JWT_SECRET_WEB: s, JWT_SECRET_ADMIN: s });
    expect(r.errors.join("\n")).toMatch(/must differ/);
  });
  it("only warns outside production", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => assertRequiredSecrets("web", { NODE_ENV: "development" })).not.toThrow();
    warn.mockRestore();
  });
});

describe("SSRF guard", () => {
  it("classifies private addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"]) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false);
  });
  it("rejects bad URLs without network", async () => {
    setSecurityEventSink(() => undefined);
    for (const u of ["http://example.com", "https://localhost/x", "https://127.0.0.1", "https://user:p@example.com", "ftp://x", "nonsense", "https://169.254.169.254/latest"]) {
      await expect(assertPublicHttpUrl(u)).rejects.toThrow("not allowed");
    }
    expect((await assertPublicHttpUrl("https://8.8.8.8/x")).hostname).toBe("8.8.8.8");
  });
});

describe("security events + csp report", () => {
  it("redacts secrets and emails", () => {
    const seen: unknown[] = [];
    setSecurityEventSink((e) => seen.push(e));
    logSecurityEvent("auth.signin_failed", { email: "a@b.co note", password: "hunter2", nested: { token: "t", ok: 1 } });
    expect(JSON.stringify(seen)).not.toContain("hunter2");
    expect(JSON.stringify(seen)).not.toContain("a@b.co");
    expect(JSON.stringify(seen)).toContain("[email]");
  });
  it("csp report handler logs violations and always answers 204", async () => {
    const seen: { type: string; data: Record<string, unknown> }[] = [];
    setSecurityEventSink((e) => seen.push(e));
    const body = JSON.stringify({ "csp-report": { "effective-directive": "script-src", "blocked-uri": "https://evil.com/x.js?q=1", "document-uri": "https://a.in/p?token=z" } });
    const res = await handleCspReport(new Request("https://a.in/api/csp-report", { method: "POST", body, headers: { "x-forwarded-for": `9.9.9.${Math.floor(Math.random() * 250)}` } }));
    expect(res.status).toBe(204);
    expect(seen[0]?.type).toBe("csp.violation");
    expect(seen[0]?.data.blocked).toBe("https://evil.com/x.js");
    expect(seen[0]?.data.document).toBe("https://a.in/p");
    expect((await handleCspReport(new Request("https://a.in/api/csp-report", { method: "POST", body: "{not json" }))).status).toBe(204);
  });
});
