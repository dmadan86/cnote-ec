import { DomainError } from "@cnote/core";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshSession = vi.hoisted(() => vi.fn());
vi.mock("@cnote/identity", async (orig) => ({ ...(await orig<object>()), refreshSession }));
vi.mock("@cnote/admin", () => ({ getStaff: async () => null }));

import { createAuthProxy } from "../src/proxy";

const NOW = new Date("2026-03-01T00:00:00Z");
const jwt = (expOffset: number | null) => `h.${Buffer.from(JSON.stringify(expOffset === null ? {} : { exp: Math.floor(NOW.getTime() / 1000) + expOffset })).toString("base64url")}.s`;
const req = (path: string, cookies: Record<string, string> = {}, headers: Record<string, string> = {}) =>
  new NextRequest(`https://app.test${path}`, { headers: { ...headers, cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") } });
const proxy = createAuthProxy({ protectedPrefixes: ["/account"], signInPath: "/signin" });
const rotated = { accessToken: jwt(900), refreshToken: "NEWRT", accessExpiresAt: new Date(), refreshExpiresAt: new Date(NOW.getTime() + 86400_000), personId: "p" };

beforeEach(() => {
  vi.stubEnv("CNOTE_AUTH_REALM", "web");
  vi.useFakeTimers({ now: NOW });
  refreshSession.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const setCookie = (res: Response) => res.headers.getSetCookie().join("\n");

describe("createAuthProxy", () => {
  it("fresh token: no refresh, passes through", async () => {
    const res = await proxy(req("/account", { cnote_web_at: jwt(600), cnote_web_rt: "rt" }));
    expect(refreshSession).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(setCookie(res)).toBe("");
  });
  it("stale (within skew) token refreshes and sets cookies; forwards ip/UA and realm", async () => {
    refreshSession.mockResolvedValue(rotated);
    const res = await proxy(req("/account", { cnote_web_at: jwt(10), cnote_web_rt: "rt" }, { "x-forwarded-for": "1.2.3.4, 5.6.7.8", "user-agent": "UA" }));
    expect(refreshSession).toHaveBeenCalledWith("rt", expect.objectContaining({ ip: "5.6.7.8", userAgent: "UA", realm: "web" })); // spoof-safe: the hop our proxy added
    expect(setCookie(res)).toContain("cnote_web_rt=NEWRT");
    expect(setCookie(res)).toContain("cnote_web_at=");
    expect(res.status).toBe(200);
  });
  it("expired token + valid refresh lets a protected path through with new cookies", async () => {
    refreshSession.mockResolvedValue(rotated);
    const res = await proxy(req("/account/x", { cnote_web_at: jwt(-100), cnote_web_rt: "rt" }, { "x-real-ip": "9.9.9.9" }));
    expect(refreshSession.mock.calls[0]![1]!.ip).toBe("9.9.9.9");
    expect(res.headers.get("location")).toBeNull();
  });
  it("missing access token but refresh present refreshes", async () => {
    refreshSession.mockResolvedValue(rotated);
    await proxy(req("/", { cnote_web_rt: "rt" }));
    expect(refreshSession).toHaveBeenCalledOnce();
  });
  it("token without exp counts as stale", async () => {
    refreshSession.mockResolvedValue(rotated);
    await proxy(req("/", { cnote_web_at: jwt(null), cnote_web_rt: "rt" }));
    expect(refreshSession).toHaveBeenCalledOnce();
  });
  it("authoritative rejection clears cookies and redirects protected paths with next", async () => {
    refreshSession.mockRejectedValue(new DomainError("unauthenticated", "no"));
    const res = await proxy(req("/account/orders?x=1", { cnote_web_at: jwt(-5), cnote_web_rt: "rt" }));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/signin");
    expect(loc.searchParams.get("next")).toBe("/account/orders?x=1");
    expect(setCookie(res)).toMatch(/cnote_web_at=;/);
    expect(setCookie(res)).toMatch(/cnote_web_rt=;/);
  });
  it("authoritative rejection on a public path clears cookies but serves the page", async () => {
    refreshSession.mockRejectedValue(new DomainError("unauthenticated", "no"));
    const res = await proxy(req("/", { cnote_web_at: jwt(-5), cnote_web_rt: "rt" }));
    expect(res.status).toBe(200);
    expect(setCookie(res)).toMatch(/cnote_web_rt=;/);
  });
  it("transient failure keeps cookies (no clearing)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    refreshSession.mockRejectedValue(new Error("redis down"));
    const res = await proxy(req("/", { cnote_web_at: jwt(10), cnote_web_rt: "rt" }));
    expect(err).toHaveBeenCalled();
    expect(setCookie(res)).toBe("");
    // still-valid (skewed) access token is honoured on protected paths
    const p = await proxy(req("/account", { cnote_web_at: jwt(10), cnote_web_rt: "rt" }));
    expect(p.status).toBe(200);
  });
  it("non-authoritative DomainError (rate_limited) keeps cookies", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    refreshSession.mockRejectedValue(new DomainError("rate_limited", "slow"));
    const res = await proxy(req("/", { cnote_web_at: jwt(-5), cnote_web_rt: "rt" }));
    expect(setCookie(res)).toBe("");
  });
  it("transient failure with expired token on protected path redirects but does not clear cookies", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    refreshSession.mockRejectedValue(new Error("db"));
    const res = await proxy(req("/account", { cnote_web_at: jwt(-5), cnote_web_rt: "rt" }));
    expect(res.status).toBe(307);
    expect(setCookie(res)).toBe("");
  });
  it("no cookies: protected redirects, public passes; exact prefix and nested; look-alike is public", async () => {
    expect((await proxy(req("/account"))).status).toBe(307);
    expect((await proxy(req("/account/a/b"))).status).toBe(307);
    expect((await proxy(req("/accounting"))).status).toBe(200);
    expect((await proxy(req("/"))).status).toBe(200);
    expect(refreshSession).not.toHaveBeenCalled();
  });
  it("expired access without refresh token on protected path redirects", async () => {
    expect((await proxy(req("/account", { cnote_web_at: jwt(-5) }))).status).toBe(307);
  });
  it("cookies are realm-specific: another realm's cookies are ignored", async () => {
    vi.stubEnv("CNOTE_AUTH_REALM", "seller");
    const res = await proxy(req("/account", { cnote_web_at: jwt(600), cnote_web_rt: "rt" }));
    expect(res.status).toBe(307);
    expect(refreshSession).not.toHaveBeenCalled();
  });
  it("prefix with trailing slash", async () => {
    const p = createAuthProxy({ protectedPrefixes: ["/a/"], signInPath: "/in" });
    expect((await p(req("/a/b"))).status).toBe(307);
  });
  it("admin realm passes an allowPerson admission guard on refresh", async () => {
    vi.stubEnv("CNOTE_AUTH_REALM", "admin");
    refreshSession.mockResolvedValue(rotated);
    await proxy(req("/account", { cnote_admin_at: jwt(-5), cnote_admin_rt: "rt" }));
    const ctx = refreshSession.mock.calls[0]![1]!;
    expect(ctx.realm).toBe("admin");
    expect(typeof ctx.allowPerson).toBe("function");
    expect(await ctx.allowPerson("p")).toBe(false); // getStaff mocked null
  });
});
