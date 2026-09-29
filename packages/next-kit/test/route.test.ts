import { DomainError } from "@cnote/core";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  completeGoogleSignIn: vi.fn(),
  googleAuthorizationUrl: vi.fn(),
  isGoogleConfigured: vi.fn(),
  refreshSession: vi.fn(),
  signOut: vi.fn(),
  beginMfaChallenge: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@cnote/identity", async (orig) => ({ ...(await orig<object>()), ...h }));
vi.mock("@cnote/admin", () => ({ getStaff: async () => null }));
vi.mock("../src/mfa-flow", () => ({ beginMfaChallenge: h.beginMfaChallenge }));

import { authRoute } from "../src/route";

const ORIGIN = "https://app.test";
const call = (action: string, method: string, path = `/api/auth/${action}`, headers: Record<string, string> = {}, cookies: Record<string, string> = {}) =>
  authRoute(
    new NextRequest(`${ORIGIN}${path}`, { method, headers: { ...headers, cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") } }),
    { params: Promise.resolve({ action }) },
  );
const oauth = (o: object) => ({ cnote_web_oauth: JSON.stringify(o) });
const setCookie = (r: Response) => r.headers.getSetCookie().join("\n");
const tokens = { accessToken: "AT", refreshToken: "RT", accessExpiresAt: new Date("2030-01-01"), refreshExpiresAt: new Date(Date.now() + 1e7), personId: "p" };

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  vi.stubEnv("CNOTE_AUTH_REALM", "web");
  for (const f of Object.values(h)) f.mockReset();
  h.isGoogleConfigured.mockReturnValue(true);
  h.beginMfaChallenge.mockResolvedValue(null);
});

describe("routing", () => {
  it("404 for unknown, 405 with Allow for wrong method", async () => {
    expect((await call("nope", "GET")).status).toBe(404);
    const a = await call("google", "POST");
    expect(a.status).toBe(405);
    expect(a.headers.get("allow")).toBe("GET");
    expect((await call("google-callback", "POST")).headers.get("allow")).toBe("GET");
    const b = await call("refresh", "GET");
    expect(b.status).toBe(405);
    expect(b.headers.get("allow")).toBe("POST");
    expect((await call("signout", "GET")).status).toBe(405);
  });
});

describe("google start", () => {
  it("not configured -> sign-in error redirect", async () => {
    h.isGoogleConfigured.mockReturnValue(false);
    const r = await call("google", "GET");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toContain("/signin?error=");
  });
  it("sets a realm-scoped PKCE cookie limited to /api/auth with sanitised next", async () => {
    h.googleAuthorizationUrl.mockResolvedValue({ url: "https://accounts.google.com/x", state: "S", codeVerifier: "V", nonce: "N" });
    const r = await call("google", "GET", "/api/auth/google?next=//evil.com");
    expect(r.headers.get("location")).toBe("https://accounts.google.com/x");
    expect(h.googleAuthorizationUrl).toHaveBeenCalledWith(`${ORIGIN}/api/auth/google-callback`);
    const c = setCookie(r);
    expect(c).toContain("cnote_web_oauth=");
    expect(c).toMatch(/Path=\/api\/auth/i);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/Max-Age=600/i);
    expect(decodeURIComponent(c)).toContain('"next":"/"');
  });
  it("Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    h.googleAuthorizationUrl.mockResolvedValue({ url: "https://g", state: "S", codeVerifier: "V", nonce: "N" });
    expect(setCookie(await call("google", "GET"))).toMatch(/Secure/i);
  });
  it("identity failure redirects with generic message and logs non-domain errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.googleAuthorizationUrl.mockRejectedValue(new Error("boom"));
    const r = await call("google", "GET");
    expect(decodeURIComponent(r.headers.get("location")!)).toContain("Google sign-in failed");
    expect(spy).toHaveBeenCalled();
    h.googleAuthorizationUrl.mockRejectedValue(new DomainError("forbidden", "closed"));
    expect(decodeURIComponent((await call("google", "GET")).headers.get("location")!)).toContain("closed");
  });
});

describe("google callback state/PKCE", () => {
  const cb = (q: string, cookies: Record<string, string> | undefined) => call("google-callback", "GET", `/api/auth/google-callback?${q}`, {}, cookies);
  const failed = (r: Response) => r.headers.get("location")!.includes("/signin?error=") && /cnote_web_oauth=;/.test(setCookie(r));

  it.each([
    ["no cookie", "code=c&state=S", undefined],
    ["state mismatch", "code=c&state=X", oauth({ state: "S", codeVerifier: "V" })],
    ["state different length", "code=c&state=SS", oauth({ state: "S", codeVerifier: "V" })],
    ["missing code", "state=S", oauth({ state: "S", codeVerifier: "V" })],
    ["missing state", "code=c", oauth({ state: "S", codeVerifier: "V" })],
    ["missing verifier", "code=c&state=S", oauth({ state: "S" })],
    ["missing saved state", "code=c&state=S", oauth({ codeVerifier: "V" })],
    ["missing saved nonce (OIDC replay protection)", "code=c&state=S", oauth({ state: "S", codeVerifier: "V" })],
    ["corrupt cookie", "code=c&state=S", { cnote_web_oauth: "{not json" }],
    ["google error", "error=access_denied&code=c&state=S", oauth({ state: "S", codeVerifier: "V" })],
  ])("rejects: %s (and clears cookie, never calls identity)", async (_n, q, cookies) => {
    expect(failed(await cb(q, cookies))).toBe(true);
    expect(h.completeGoogleSignIn).not.toHaveBeenCalled();
  });
  it("other realm's oauth cookie is not honoured", async () => {
    expect(failed(await cb("code=c&state=S", { cnote_seller_oauth: JSON.stringify({ state: "S", codeVerifier: "V" }) }))).toBe(true);
  });
  it("success: passes verifier + redirect uri, sets cookies, clears oauth cookie, redirects to saved next", async () => {
    h.completeGoogleSignIn.mockResolvedValue(tokens);
    const r = await cb("code=c&state=S", oauth({ state: "S", codeVerifier: "V", nonce: "N", next: "/acct" }));
    expect(h.completeGoogleSignIn).toHaveBeenCalledWith({ code: "c", codeVerifier: "V", nonce: "N", redirectUri: `${ORIGIN}/api/auth/google-callback` }, expect.objectContaining({ realm: "web" }));
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`${ORIGIN}/acct`);
    expect(setCookie(r)).toContain("cnote_web_at=AT");
    expect(setCookie(r)).toMatch(/cnote_web_oauth=;/);
  });
  it("tampered saved next cannot redirect off-site", async () => {
    h.completeGoogleSignIn.mockResolvedValue(tokens);
    const r = await cb("code=c&state=S", oauth({ state: "S", codeVerifier: "V", nonce: "N", next: "//evil.com" }));
    expect(r.headers.get("location")).toBe(`${ORIGIN}/`);
  });
  it("MFA due: sets only the pending cookie and goes to the challenge page", async () => {
    h.completeGoogleSignIn.mockResolvedValue(tokens);
    h.beginMfaChallenge.mockResolvedValue({ cookie: { name: "cnote_web_mfa", value: "id", path: "/" }, path: "/mfa" });
    const r = await cb("code=c&state=S", oauth({ state: "S", codeVerifier: "V", nonce: "N", next: "/x" }));
    expect(r.headers.get("location")).toBe(`${ORIGIN}/mfa`);
    const c = setCookie(r);
    expect(c).toContain("cnote_web_mfa=id");
    expect(c).not.toContain("cnote_web_at=AT");
    expect(c).not.toContain("cnote_web_rt=RT");
  });
  it("identity rejection shows its message on sign-in", async () => {
    h.completeGoogleSignIn.mockRejectedValue(new DomainError("forbidden", "Email not verified"));
    const r = await cb("code=c&state=S", oauth({ state: "S", codeVerifier: "V", nonce: "N" }));
    expect(decodeURIComponent(r.headers.get("location")!)).toContain("Email not verified");
  });
});

describe("refresh", () => {
  it("rejects cross-origin POST with 403 before touching identity", async () => {
    const r = await call("refresh", "POST", undefined, { origin: "https://evil.test" }, { cnote_web_rt: "rt" });
    expect(r.status).toBe(403);
    expect(h.refreshSession).not.toHaveBeenCalled();
  });
  it("same origin or no Origin header is allowed", async () => {
    h.refreshSession.mockResolvedValue(tokens);
    for (const headers of [{ origin: ORIGIN }, {}] as Array<Record<string, string>>) {
      const r = await call("refresh", "POST", undefined, headers, { cnote_web_rt: "rt" });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ ok: true });
      expect(setCookie(r)).toContain("cnote_web_rt=RT");
    }
    expect(h.refreshSession).toHaveBeenCalledWith("rt", expect.objectContaining({ realm: "web" }));
  });
  it("no refresh cookie -> 401 and cookies cleared", async () => {
    const r = await call("refresh", "POST");
    expect(r.status).toBe(401);
    expect(setCookie(r)).toMatch(/cnote_web_rt=;/);
  });
  it("authoritative rejection clears cookies; transient error does not", async () => {
    h.refreshSession.mockRejectedValue(new DomainError("unauthenticated", "revoked"));
    const a = await call("refresh", "POST", undefined, {}, { cnote_web_rt: "rt" });
    expect(a.status).toBe(401);
    expect(setCookie(a)).toMatch(/cnote_web_at=;/);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.refreshSession.mockRejectedValue(new Error("redis"));
    const b = await call("refresh", "POST", undefined, {}, { cnote_web_rt: "rt" });
    expect(b.status).toBe(500);
    expect(setCookie(b)).toBe("");
  });
});

describe("signout", () => {
  it("cross-origin blocked", async () => {
    const r = await call("signout", "POST", undefined, { origin: "https://evil.test" }, { cnote_web_rt: "rt" });
    expect(r.status).toBe(403);
    expect(h.signOut).not.toHaveBeenCalled();
  });
  it("revokes in this realm, clears cookies, 303 to /", async () => {
    const r = await call("signout", "POST", undefined, {}, { cnote_web_rt: "rt" });
    expect(h.signOut).toHaveBeenCalledWith("rt", "web");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`${ORIGIN}/`);
    expect(setCookie(r)).toMatch(/cnote_web_rt=;/);
  });
  it("without refresh cookie still clears", async () => {
    const r = await call("signout", "POST");
    expect(h.signOut).not.toHaveBeenCalled();
    expect(r.status).toBe(303);
  });
  it("identity failure maps to error response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.signOut.mockRejectedValue(new Error("x"));
    expect((await call("signout", "POST", undefined, {}, { cnote_web_rt: "rt" })).status).toBe(500);
  });
});
