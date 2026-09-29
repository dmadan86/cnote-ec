import { DomainError } from "@cnote/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeJar } from "./helpers";

const h = vi.hoisted(() => ({
  jar: null as unknown as ReturnType<typeof import("./helpers").makeJar>,
  signInWithPassword: vi.fn(),
  signUpWithPassword: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
  signOut: vi.fn(),
  logSecurityEvent: vi.fn(),
  verifyHumanOrThrow: vi.fn(),
  beginMfaChallenge: vi.fn(),
  requestContext: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => h.jar.store }));
vi.mock("next/navigation", () => ({
  redirect: (u: string) => {
    throw new Error(`REDIRECT:${u}`);
  },
}));
vi.mock("@cnote/identity", async (orig) => ({ ...(await orig<object>()), ...h }));
vi.mock("@cnote/admin", () => ({ getStaff: async () => null }));
vi.mock("@cnote/security", async (orig) => ({ ...(await orig<object>()), logSecurityEvent: h.logSecurityEvent }));
vi.mock("../src/human", () => ({ verifyHumanOrThrow: h.verifyHumanOrThrow }));
vi.mock("../src/mfa-flow", () => ({ beginMfaChallenge: h.beginMfaChallenge }));
vi.mock("../src/session", () => ({ requestContext: h.requestContext }));

import { forgotPasswordAction, resetPasswordAction, signInAction, signOutAction, signUpAction } from "../src/actions";

const tok = { accessToken: "AT", refreshToken: "RT", accessExpiresAt: new Date(), refreshExpiresAt: new Date(Date.now() + 1e6), personId: "p" };
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

beforeEach(() => {
  vi.stubEnv("CNOTE_AUTH_REALM", "web");
  h.jar = makeJar();
  for (const k of Object.keys(h)) if (typeof (h as never)[k] === "function" && "mockReset" in (h as never)[k]) ((h as never)[k] as ReturnType<typeof vi.fn>).mockReset();
  h.requestContext.mockResolvedValue({ ip: "1.1.1.1", userAgent: "ua", realm: "web" });
  h.beginMfaChallenge.mockResolvedValue(null);
});

describe("signInAction", () => {
  it("sets cookies and redirects to safe next", async () => {
    h.signInWithPassword.mockResolvedValue(tok);
    await expect(signInAction(null, fd({ email: "a@b.c", password: "pw", next: "/acct" }))).rejects.toThrow("REDIRECT:/acct");
    expect(h.jar.map.get("cnote_web_at")).toBe("AT");
    expect(h.signInWithPassword).toHaveBeenCalledWith({ email: "a@b.c", password: "pw" }, expect.objectContaining({ ip: "1.1.1.1" }));
  });
  it("open-redirect next falls back to /", async () => {
    h.signInWithPassword.mockResolvedValue(tok);
    await expect(signInAction(null, fd({ email: "a", password: "b", next: "//evil.com" }))).rejects.toThrow("REDIRECT:/");
  });
  it("MFA due: parks session, sets only pending cookie, redirects to challenge", async () => {
    h.signInWithPassword.mockResolvedValue(tok);
    h.beginMfaChallenge.mockResolvedValue({ cookie: { name: "cnote_web_mfa", value: "id" }, path: "/mfa" });
    await expect(signInAction(null, fd({ email: "a", password: "b" }))).rejects.toThrow("REDIRECT:/mfa");
    expect(h.jar.map.get("cnote_web_mfa")).toBe("id");
    expect(h.jar.map.has("cnote_web_at")).toBe(false);
    expect(h.jar.map.has("cnote_web_rt")).toBe(false);
  });
  it("wrong credentials: logs security event, returns error, no cookies", async () => {
    h.signInWithPassword.mockRejectedValue(new DomainError("unauthenticated", "Invalid email or password."));
    expect(await signInAction(null, fd({ email: "a", password: "b" }))).toEqual({ ok: false, error: "Invalid email or password." });
    expect(h.logSecurityEvent).toHaveBeenCalledWith("auth.signin_failed", { realm: "web", ip: "1.1.1.1" });
    expect(h.jar.map.size).toBe(0);
  });
  it("other domain errors are returned without a signin_failed event; missing fields become empty strings", async () => {
    h.signInWithPassword.mockRejectedValue(new DomainError("rate_limited", "Too many"));
    expect(await signInAction(null, new FormData())).toEqual({ ok: false, error: "Too many" });
    expect(h.logSecurityEvent).not.toHaveBeenCalled();
    expect(h.signInWithPassword).toHaveBeenCalledWith({ email: "", password: "" }, expect.anything());
  });
  it("unexpected errors propagate", async () => {
    h.signInWithPassword.mockRejectedValue(new Error("db"));
    await expect(signInAction(null, fd({}))).rejects.toThrow("db");
  });
  it("ignores non-string form values (File)", async () => {
    h.signInWithPassword.mockResolvedValue(tok);
    const f = new FormData();
    f.set("email", new File(["x"], "x.txt"));
    await expect(signInAction(null, f)).rejects.toThrow("REDIRECT:/");
    expect(h.signInWithPassword.mock.calls[0]![0]!.email).toBe("");
  });
});

describe("signUpAction", () => {
  const base = { email: "a@b.c", password: "pw", name: "N", consent_matching: "on" };
  it("requires matching consent before anything else", async () => {
    const r = await signUpAction(null, fd({ ...base, consent_matching: "off" }));
    expect(r).toMatchObject({ ok: false, fieldErrors: { consent_matching: expect.any(String) } });
    expect(h.verifyHumanOrThrow).not.toHaveBeenCalled();
    expect(h.signUpWithPassword).not.toHaveBeenCalled();
  });
  it("human check failure blocks account creation", async () => {
    h.verifyHumanOrThrow.mockRejectedValue(new DomainError("forbidden", "bot"));
    expect(await signUpAction(null, fd(base))).toEqual({ ok: false, error: "bot" });
    expect(h.signUpWithPassword).not.toHaveBeenCalled();
  });
  it("passes consents (marketing optional), sets cookies, redirects", async () => {
    h.signUpWithPassword.mockResolvedValue(tok);
    await expect(signUpAction(null, fd({ ...base, consent_marketing: "on", next: "/n" }))).rejects.toThrow("REDIRECT:/n");
    expect(h.signUpWithPassword.mock.calls[0]![0]!).toMatchObject({ consents: { matching: true, marketing: true } });
    expect(h.jar.map.get("cnote_web_rt")).toBe("RT");
    h.signUpWithPassword.mockResolvedValue(tok);
    await expect(signUpAction(null, fd(base))).rejects.toThrow("REDIRECT:/");
    expect(h.signUpWithPassword.mock.calls[1]![0]!.consents).toEqual({ matching: true, marketing: false });
  });
  it("surfaces sign-up domain errors (e.g. weak password)", async () => {
    h.signUpWithPassword.mockRejectedValue(new DomainError("validation", "weak"));
    expect(await signUpAction(null, fd(base))).toEqual({ ok: false, error: "weak" });
  });
});

describe("forgot / reset / signOut", () => {
  it("forgot returns ok without revealing existence", async () => {
    h.requestPasswordReset.mockResolvedValue(undefined);
    expect(await forgotPasswordAction(null, fd({ email: "x@y.z" }))).toEqual({ ok: true, data: undefined });
    expect(h.requestPasswordReset).toHaveBeenCalledWith("x@y.z", expect.anything());
  });
  it("reset error is returned; success redirects to safe target, default /signin", async () => {
    h.resetPassword.mockRejectedValueOnce(new DomainError("validation", "bad token"));
    expect(await resetPasswordAction(null, fd({ token: "t", password: "p" }))).toEqual({ ok: false, error: "bad token" });
    h.resetPassword.mockResolvedValue(undefined);
    await expect(resetPasswordAction(null, fd({ token: "t", password: "p" }))).rejects.toThrow("REDIRECT:/signin");
    await expect(resetPasswordAction(null, fd({ token: "t", password: "p", redirectTo: "//evil" }))).rejects.toThrow("REDIRECT:/signin");
    await expect(resetPasswordAction(null, fd({ token: "t", password: "p", redirectTo: "/ok" }))).rejects.toThrow("REDIRECT:/ok");
  });
  it("signOut revokes this realm's refresh token and clears cookies", async () => {
    h.jar.map.set("cnote_web_rt", "RT");
    h.jar.map.set("cnote_web_at", "AT");
    await expect(signOutAction()).rejects.toThrow("REDIRECT:/");
    expect(h.signOut).toHaveBeenCalledWith("RT", "web");
    expect(h.jar.map.size).toBe(0);
  });
  it("signOut without a refresh token still clears and redirects", async () => {
    await expect(signOutAction()).rejects.toThrow("REDIRECT:/");
    expect(h.signOut).not.toHaveBeenCalled();
  });
});
