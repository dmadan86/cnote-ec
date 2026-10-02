import { NextRequest, NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
import { createNonce, NONCE_HEADER, pathMatches, secureNext, withNonceRequest, withSecurityHeaders } from "../src/security";

describe("createNonce", () => {
  it("is 128-bit base64 and unique per call", () => {
    const a = createNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(createNonce()).not.toBe(a);
  });
});

describe("withSecurityHeaders", () => {
  it("sets headers on redirects too", () => {
    const res = withSecurityHeaders(NextResponse.redirect("https://x.test/signin"), { app: "admin", nonce: "abc" });
    expect(res.status).toBe(307);
    expect(res.headers.get("content-security-policy")).toContain("'nonce-abc'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
  });
  it("reset-password (token in the URL) is always no-referrer, other pages keep the app policy", () => {
    const reset = withSecurityHeaders(NextResponse.next(), { app: "web" }, "/reset-password");
    expect(reset.headers.get("referrer-policy")).toBe("no-referrer");
    expect(withSecurityHeaders(NextResponse.next(), { app: "seller" }, "/reset-password").headers.get("referrer-policy")).toBe("no-referrer");
    expect(withSecurityHeaders(NextResponse.next(), { app: "web" }, "/grievance/verify").headers.get("referrer-policy")).toBe("no-referrer");
    expect(withSecurityHeaders(NextResponse.next(), { app: "web" }, "/account").headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(withSecurityHeaders(NextResponse.next(), { app: "web" }).headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });
  it("static mode has no nonce", () => {
    const res = withSecurityHeaders(NextResponse.next(), { app: "web" });
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self' 'unsafe-inline'");
    expect(res.headers.get("x-robots-tag")).toBeNull();
  });
});

describe("withNonceRequest", () => {
  it("adds x-nonce and the CSP to request headers and keeps cookies/url", () => {
    const req = new NextRequest("https://x.test/account?a=1", { headers: { cookie: "a=b" } });
    const out = withNonceRequest(req, "n0nce", { app: "web" });
    expect(out.headers.get(NONCE_HEADER)).toBe("n0nce");
    expect(out.headers.get("content-security-policy")).toContain("'nonce-n0nce'");
    expect(out.nextUrl.pathname).toBe("/account");
    expect(out.cookies.get("a")?.value).toBe("b");
  });
  it("forwards them via NextResponse.next", () => {
    const res = secureNext(new NextRequest("https://x.test/"), { app: "seller", nonce: "zz" });
    expect(res.headers.get("x-middleware-request-x-nonce")).toBe("zz");
    expect(res.headers.get("content-security-policy")).toContain("'nonce-zz'");
  });
});

describe("pathMatches", () => {
  it("matches exact and nested, not look-alikes", () => {
    expect(pathMatches("/account", ["/account"])).toBe(true);
    expect(pathMatches("/account/x", ["/account"])).toBe(true);
    expect(pathMatches("/accounting", ["/account"])).toBe(false);
  });
});
