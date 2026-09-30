import { DomainError } from "@cnote/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  beginMfaEnrollment: vi.fn(),
  confirmMfaEnrollment: vi.fn(),
  disableMfa: vi.fn(),
  mfaStatus: vi.fn(),
  regenerateRecoveryCodes: vi.fn(),
  verifyMfa: vi.fn(),
  getMfaPending: vi.fn(),
  completeMfaChallenge: vi.fn(),
  discardMfaChallenge: vi.fn(),
  currentSession: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (u: string) => {
    throw new Error(`REDIRECT:${u}`);
  },
}));
vi.mock("@cnote/identity", async (orig) => ({ ...(await orig<object>()), ...h }));
vi.mock("@cnote/admin", () => ({ getStaff: async () => null }));
vi.mock("../src/mfa-flow", () => ({ getMfaPending: h.getMfaPending, completeMfaChallenge: h.completeMfaChallenge, discardMfaChallenge: h.discardMfaChallenge, MFA_PATH: "/mfa" }));
vi.mock("../src/session", () => ({ currentSession: h.currentSession }));

import * as A from "../src/mfa-actions";

const fd = (code: string) => {
  const f = new FormData();
  f.set("code", code);
  return f;
};
beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
});

describe("mfaChallengeAction", () => {
  it("expired when no pending or wrong mode; never verifies", async () => {
    h.getMfaPending.mockResolvedValue(null);
    expect(await A.mfaChallengeAction(null, fd("1"))).toMatchObject({ ok: false, error: expect.stringMatching(/expired/) });
    h.getMfaPending.mockResolvedValue({ personId: "p", mode: "enroll", next: "/" });
    expect(await A.mfaChallengeAction(null, fd("1"))).toMatchObject({ ok: false });
    expect(h.verifyMfa).not.toHaveBeenCalled();
    expect(h.completeMfaChallenge).not.toHaveBeenCalled();
  });
  it("wrong code returns the error and does not release the session", async () => {
    h.getMfaPending.mockResolvedValue({ personId: "p", mode: "verify", next: "/" });
    h.verifyMfa.mockRejectedValue(new DomainError("unauthenticated", "Invalid code"));
    expect(await A.mfaChallengeAction(null, fd("000000"))).toEqual({ ok: false, error: "Invalid code" });
    expect(h.completeMfaChallenge).not.toHaveBeenCalled();
  });
  it("trims and truncates code to 64 chars, releases and redirects", async () => {
    h.getMfaPending.mockResolvedValue({ personId: "p", mode: "verify", next: "/" });
    h.completeMfaChallenge.mockResolvedValue("/dash");
    await expect(A.mfaChallengeAction(null, fd("  " + "9".repeat(80) + "  "))).rejects.toThrow("REDIRECT:/dash");
    expect(h.verifyMfa).toHaveBeenCalledWith("p", "9".repeat(64));
  });
  it("sanitises next on release; expired parked session yields error", async () => {
    h.getMfaPending.mockResolvedValue({ personId: "p", mode: "verify", next: "/" });
    h.completeMfaChallenge.mockResolvedValueOnce("//evil.com");
    await expect(A.mfaChallengeAction(null, fd("1"))).rejects.toThrow("REDIRECT:/");
    h.completeMfaChallenge.mockResolvedValueOnce(null);
    expect(await A.mfaChallengeAction(null, fd("1"))).toMatchObject({ ok: false });
  });
  it("non-string code becomes empty", async () => {
    h.getMfaPending.mockResolvedValue({ personId: "p", mode: "verify", next: "/" });
    h.completeMfaChallenge.mockResolvedValue("/");
    const f = new FormData();
    await expect(A.mfaChallengeAction(null, f)).rejects.toThrow("REDIRECT");
    expect(h.verifyMfa).toHaveBeenCalledWith("p", "");
  });
});

describe("enroll / finish / cancel", () => {
  it("enroll confirm requires pending enroll mode", async () => {
    h.getMfaPending.mockResolvedValue({ personId: "p", mode: "verify", next: "/" });
    expect((await A.mfaEnrollConfirmAction(null, fd("1"))).ok).toBe(false);
    h.getMfaPending.mockResolvedValue({ personId: "p", mode: "enroll", next: "/" });
    h.confirmMfaEnrollment.mockResolvedValue({ recoveryCodes: ["a"] });
    expect(await A.mfaEnrollConfirmAction(null, fd("123456"))).toEqual({ ok: true, data: { recoveryCodes: ["a"] } });
    h.getMfaPending.mockResolvedValue(null);
    expect((await A.mfaEnrollConfirmAction(null, fd("1"))).ok).toBe(false);
  });
  it("finish releases only when MFA is really enabled", async () => {
    h.getMfaPending.mockResolvedValue({ personId: "p", mode: "enroll", next: "/" });
    h.mfaStatus.mockResolvedValue({ enabled: false });
    await expect(A.mfaFinishAction()).rejects.toThrow("REDIRECT:/mfa");
    expect(h.completeMfaChallenge).not.toHaveBeenCalled();
    h.mfaStatus.mockResolvedValue({ enabled: true });
    h.completeMfaChallenge.mockResolvedValue("/dash");
    await expect(A.mfaFinishAction()).rejects.toThrow("REDIRECT:/dash");
    h.completeMfaChallenge.mockResolvedValue(null);
    await expect(A.mfaFinishAction()).rejects.toThrow("REDIRECT:/mfa");
    h.getMfaPending.mockResolvedValue(null);
    await expect(A.mfaFinishAction()).rejects.toThrow("REDIRECT:/mfa");
  });
  it("cancel discards and goes to sign-in", async () => {
    await expect(A.mfaCancelAction()).rejects.toThrow("REDIRECT:/signin");
    expect(h.discardMfaChallenge).toHaveBeenCalled();
  });
});

describe("account settings actions require a session", () => {
  it.each([
    ["mfaStatusAction", () => A.mfaStatusAction()],
    ["mfaBeginAction", () => A.mfaBeginAction()],
    ["mfaConfirmAction", () => A.mfaConfirmAction(null, fd("1"))],
    ["mfaDisableAction", () => A.mfaDisableAction(null, fd("1"))],
    ["mfaRegenerateAction", () => A.mfaRegenerateAction(null, fd("1"))],
  ])("%s rejects when signed out", async (_n, call) => {
    h.currentSession.mockResolvedValue(null);
    expect(await call()).toEqual({ ok: false, error: "Please sign in again.", errorKey: "auth.pleaseSignIn" });
    for (const k of ["mfaStatus", "beginMfaEnrollment", "confirmMfaEnrollment", "disableMfa", "regenerateRecoveryCodes"]) expect((h as never)[k]).not.toHaveBeenCalled();
  });
  it("delegates with the session's person", async () => {
    h.currentSession.mockResolvedValue({ personId: "p", email: "e@x.y" });
    h.mfaStatus.mockResolvedValue({ enabled: true });
    expect(await A.mfaStatusAction()).toEqual({ ok: true, data: { enabled: true } });
    h.beginMfaEnrollment.mockResolvedValue({ otpauthUri: "u", manualKey: "k" });
    await A.mfaBeginAction();
    expect(h.beginMfaEnrollment).toHaveBeenCalledWith("p", "e@x.y");
    h.currentSession.mockResolvedValue({ personId: "p" });
    await A.mfaBeginAction();
    expect(h.beginMfaEnrollment).toHaveBeenLastCalledWith("p", "p");
    h.confirmMfaEnrollment.mockResolvedValue({ recoveryCodes: [] });
    await A.mfaConfirmAction(null, fd(" 12 "));
    expect(h.confirmMfaEnrollment).toHaveBeenCalledWith("p", "12");
    await A.mfaDisableAction(null, fd("5"));
    expect(h.disableMfa).toHaveBeenCalledWith("p", "5");
    h.regenerateRecoveryCodes.mockResolvedValue(["c1"]);
    expect(await A.mfaRegenerateAction(null, fd("7"))).toEqual({ ok: true, data: { recoveryCodes: ["c1"] } });
  });
});
