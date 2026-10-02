import { DomainError } from "@cnote/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeJar } from "./helpers";

const h = vi.hoisted(() => ({
  jar: null as unknown as ReturnType<typeof import("./helpers").makeJar>,
  requestLoginOtp: vi.fn(),
  requestPhoneOtp: vi.fn(),
  verifyLoginOtp: vi.fn(),
  verifyPhoneOtp: vi.fn(),
  completeUnlock: vi.fn(),
  markOtpSent: vi.fn(),
  markVerified: vi.fn(),
  startCapture: vi.fn(),
  currentSession: vi.fn(),
  requestContext: vi.fn(),
  verifyHumanTokenOrThrow: vi.fn(),
  beginMfaChallenge: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => h.jar.store }));
vi.mock("@cnote/identity", async (orig) => ({ ...(await orig<object>()), requestLoginOtp: h.requestLoginOtp, requestPhoneOtp: h.requestPhoneOtp, verifyLoginOtp: h.verifyLoginOtp, verifyPhoneOtp: h.verifyPhoneOtp }));
vi.mock("@cnote/admin", () => ({ getStaff: async () => null }));
vi.mock("@cnote/leadgen", () => ({ completeUnlock: h.completeUnlock, markOtpSent: h.markOtpSent, markVerified: h.markVerified, startCapture: h.startCapture }));
vi.mock("../src/session", () => ({ currentSession: h.currentSession, requestContext: h.requestContext }));
vi.mock("../src/human", () => ({ verifyHumanTokenOrThrow: h.verifyHumanTokenOrThrow }));
vi.mock("../src/mfa-flow", () => ({ beginMfaChallenge: h.beginMfaChallenge }));

import { sendOtp, startUnlock, verifyOtp } from "../src/otp";

const input = { visitorId: "v" } as never;
beforeEach(() => {
  vi.stubEnv("CNOTE_AUTH_REALM", "web");
  h.jar = makeJar();
  for (const f of Object.values(h)) if (typeof f === "function") (f as ReturnType<typeof vi.fn>).mockReset();
  h.requestContext.mockResolvedValue({ ip: "1.1.1.1", realm: "web" });
  h.currentSession.mockResolvedValue(null);
  h.beginMfaChallenge.mockResolvedValue(null);
});

describe("startUnlock", () => {
  it("anonymous: opens an anonymous capture only", async () => {
    h.startCapture.mockResolvedValue({ captureId: "c1" });
    expect(await startUnlock(input)).toEqual({ ok: true, data: { signedIn: false, captureId: "c1" } });
    expect(h.startCapture).toHaveBeenCalledWith(input, null);
    expect(h.completeUnlock).not.toHaveBeenCalled();
  });
  it("signed in with unverified phone still needs the dialog", async () => {
    h.currentSession.mockResolvedValue({ personId: "p", phoneVerified: false });
    h.startCapture.mockResolvedValue({ captureId: "c1" });
    expect((await startUnlock(input)) as unknown).toMatchObject({ ok: true, data: { signedIn: false } });
  });
  it("signed in with verified phone completes immediately", async () => {
    h.currentSession.mockResolvedValue({ personId: "p", phoneVerified: true });
    h.startCapture.mockResolvedValue({ captureId: "c1" });
    h.completeUnlock.mockResolvedValue({ unlocked: true });
    expect(await startUnlock(input, { name: "n" } as never, "tok")).toEqual({ ok: true, data: { signedIn: true, captureId: "c1", result: { unlocked: true } } });
    expect(h.markVerified).toHaveBeenCalledWith("c1", "p", false);
    expect(h.completeUnlock).toHaveBeenCalledWith("p", "c1", { name: "n" });
  });
  it("domain errors become results", async () => {
    h.startCapture.mockRejectedValue(new DomainError("validation", "bad"));
    expect(await startUnlock(input)).toEqual({ ok: false, error: "bad" });
  });
});

describe("sendOtp", () => {
  it("human check failure stops before any SMS", async () => {
    h.verifyHumanTokenOrThrow.mockRejectedValue(new DomainError("forbidden", "bot"));
    expect(await sendOtp("c", "9876543210", "sms", false, "t")).toEqual({ ok: false, error: "bot" });
    expect(h.requestLoginOtp).not.toHaveBeenCalled();
    expect(h.requestPhoneOtp).not.toHaveBeenCalled();
    expect(h.markOtpSent).not.toHaveBeenCalled();
  });
  it("anonymous: login OTP with visitor id and channel; devCode passed through only when present", async () => {
    h.requestLoginOtp.mockResolvedValue({ resendAfterSeconds: 45, channel: "whatsapp", devCode: "123456" });
    const r = await sendOtp("c", "9876543210", "whatsapp", true, "t", "vis");
    expect(r).toEqual({ ok: true, data: { resendAfterSeconds: 45, channel: "whatsapp", devCode: "123456" } });
    expect(h.requestLoginOtp).toHaveBeenCalledWith("9876543210", expect.objectContaining({ visitorId: "vis" }), { channel: "whatsapp" });
    expect(h.markOtpSent).toHaveBeenCalledWith("c", "9876543210", true);
    h.requestLoginOtp.mockResolvedValue({ resendAfterSeconds: 30, channel: "sms" });
    const r2 = await sendOtp("c", "9876543210", "sms");
    expect(r2).toEqual({ ok: true, data: { resendAfterSeconds: 30, channel: "sms" } });
    expect(h.requestLoginOtp.mock.calls[1]![1]!.visitorId).toBeNull();
  });
  it("signed in without verified phone verifies that account's phone (no account switch)", async () => {
    h.currentSession.mockResolvedValue({ personId: "p", phoneVerified: false });
    h.requestPhoneOtp.mockResolvedValue({ devCode: "111111" });
    expect(await sendOtp("c", "9876543210", "whatsapp")).toEqual({ ok: true, data: { resendAfterSeconds: 30, channel: "sms", devCode: "111111" } });
    expect(h.requestPhoneOtp).toHaveBeenCalledWith("p", "9876543210");
    expect(h.requestLoginOtp).not.toHaveBeenCalled();
    h.requestPhoneOtp.mockResolvedValue({});
    expect(await sendOtp("c", "9876543210", "sms")).toEqual({ ok: true, data: { resendAfterSeconds: 30, channel: "sms" } });
  });
  it("rate limit surfaced", async () => {
    h.requestLoginOtp.mockRejectedValue(new DomainError("rate_limited", "Slow down"));
    expect(await sendOtp("c", "p", "sms")).toEqual({ ok: false, error: "Slow down" });
    expect(h.markOtpSent).not.toHaveBeenCalled();
  });
});

describe("verifyOtp", () => {
  const consent = { matching: true };
  const tokens = { accessToken: "AT", refreshToken: "RT", accessExpiresAt: new Date(), refreshExpiresAt: new Date(Date.now() + 1e6), personId: "p", isNew: false };
  it("MFA enabled: parks the session behind the MFA step; no auth cookies, no unlock", async () => {
    h.verifyLoginOtp.mockResolvedValue(tokens);
    h.beginMfaChallenge.mockResolvedValue({ cookie: { name: "cnote_web_mfa", value: "pend", httpOnly: true, sameSite: "lax", secure: false, path: "/", maxAge: 300 }, path: "/mfa" });
    expect(await verifyOtp("c", "98", "123456", consent)).toEqual({ ok: true, data: { mfaRequired: true, path: "/mfa" } });
    expect(h.beginMfaChallenge).toHaveBeenCalledWith(tokens, null);
    expect(h.jar.map.get("cnote_web_at")).toBeUndefined();
    expect(h.jar.map.get("cnote_web_mfa")).toBe("pend");
    expect(h.completeUnlock).not.toHaveBeenCalled();
    expect(h.markVerified).not.toHaveBeenCalled();
  });
  it("admin realm: phone OTP sign-in is refused outright (send and verify)", async () => {
    vi.stubEnv("CNOTE_AUTH_REALM", "admin");
    expect(await sendOtp("c", "98", "sms")).toMatchObject({ ok: false });
    expect(await verifyOtp("c", "98", "123456", consent)).toMatchObject({ ok: false });
    expect(h.requestLoginOtp).not.toHaveBeenCalled();
    expect(h.verifyLoginOtp).not.toHaveBeenCalled();
    expect(h.jar.map.size).toBe(0);
  });
  it("anonymous: sets realm cookies, marks capture, completes unlock", async () => {
    const t = { accessToken: "AT", refreshToken: "RT", accessExpiresAt: new Date(), refreshExpiresAt: new Date(Date.now() + 1e6), personId: "p", isNew: true };
    h.verifyLoginOtp.mockResolvedValue(t);
    h.completeUnlock.mockResolvedValue({ unlocked: true });
    expect(await verifyOtp("c", "98", "123456", { matching: true, marketing: true }, undefined, "vis")).toEqual({ ok: true, data: { result: { unlocked: true }, isNew: true } });
    expect(h.verifyLoginOtp).toHaveBeenCalledWith("98", "123456", expect.objectContaining({ visitorId: "vis" }), { consents: { matching: true, marketing: true } });
    expect(h.jar.map.get("cnote_web_at")).toBe("AT");
    expect(h.markVerified).toHaveBeenCalledWith("c", "p", true, "98");
  });
  it("marketing consent defaults to false unless exactly true", async () => {
    h.verifyLoginOtp.mockResolvedValue({ accessToken: "a", refreshToken: "r", accessExpiresAt: new Date(), refreshExpiresAt: new Date(Date.now() + 1e6), personId: "p", isNew: false });
    h.completeUnlock.mockResolvedValue({});
    await verifyOtp("c", "98", "1", consent);
    expect(h.verifyLoginOtp.mock.calls[0]![3]!).toEqual({ consents: { matching: true, marketing: false } });
  });
  it("wrong code: nothing issued or marked", async () => {
    h.verifyLoginOtp.mockRejectedValue(new DomainError("unauthenticated", "wrong"));
    expect(await verifyOtp("c", "98", "0", consent)).toEqual({ ok: false, error: "wrong" });
    expect(h.jar.map.size).toBe(0);
    expect(h.markVerified).not.toHaveBeenCalled();
  });
  it("signed in unverified: verifies onto same account, no new cookies", async () => {
    h.currentSession.mockResolvedValue({ personId: "p", phoneVerified: false });
    h.verifyPhoneOtp.mockResolvedValue({ verified: true });
    h.completeUnlock.mockResolvedValue({ ok: 1 });
    expect(await verifyOtp("c", "98", "1", consent, { x: 1 } as never)).toEqual({ ok: true, data: { result: { ok: 1 }, isNew: false } });
    expect(h.markVerified).toHaveBeenCalledWith("c", "p", false, "98");
    expect(h.jar.map.size).toBe(0);
  });
  it("signed in with incorrect code -> validation error, capture untouched", async () => {
    h.currentSession.mockResolvedValue({ personId: "p", phoneVerified: false });
    h.verifyPhoneOtp.mockResolvedValue({ verified: false });
    const r = await verifyOtp("c", "98", "1", consent);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/incorrect or has expired/), errorKey: "auth.codeIncorrectExpired" });
    expect(h.markVerified).not.toHaveBeenCalled();
    expect(h.completeUnlock).not.toHaveBeenCalled();
  });
});
