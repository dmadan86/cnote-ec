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
  getMfaPendingAccount: vi.fn(),
  beginPasskeyAuthentication: vi.fn(),
  finishPasskeyAuthentication: vi.fn(),
  beginPasskeyRegistration: vi.fn(),
  finishPasskeyRegistration: vi.fn(),
  verifyPasskeyStepUp: vi.fn(),
  renamePasskey: vi.fn(),
  revokePasskey: vi.fn(),
  listPasskeys: vi.fn(),
  passkeyPolicy: vi.fn(),
  getStaff: vi.fn(),
  writeAudit: vi.fn(),
  realm: "admin",
  upgrade: false,
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (u: string) => {
    throw new Error(`REDIRECT:${u}`);
  },
}));
vi.mock("@cnote/identity", async (orig) => ({ ...(await orig<object>()), ...h }));
vi.mock("@cnote/admin", () => ({ getStaff: h.getStaff, writeAudit: h.writeAudit }));
vi.mock("../src/realm", () => ({ appRealm: () => h.realm }));
vi.mock("../src/mfa-flow", () => ({
  getMfaPending: h.getMfaPending,
  getMfaPendingAccount: h.getMfaPendingAccount,
  completeMfaChallenge: h.completeMfaChallenge,
  discardMfaChallenge: h.discardMfaChallenge,
  // mirrors the real helper for the non-upgrade path; the upgrade path is covered by afterSecondFactor's own tests (mfa-flow.test.ts)
  afterSecondFactor: async () => {
    if (h.upgrade) return { kind: "upgrade" };
    const next = await h.completeMfaChallenge();
    return next === null ? { kind: "expired" } : { kind: "released", next };
  },
  MFA_PATH: "/mfa",
}));
vi.mock("../src/session", () => ({ currentSession: h.currentSession }));

import * as A from "../src/mfa-actions";

const fd = (code: string) => {
  const f = new FormData();
  f.set("code", code);
  return f;
};
beforeEach(() => {
  for (const f of Object.values(h)) if (typeof f === "function") f.mockReset();
  h.realm = "admin";
  h.upgrade = false;
  h.getStaff.mockResolvedValue({ id: "staff-1" });
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
  it("policy: someone holding a passkey cannot use a code; an upgrade keeps the session parked and goes back to /mfa", async () => {
    h.getMfaPending.mockResolvedValue({ personId: "p", mode: "verify", next: "/", hasPasskey: true, passkeyRequired: true });
    expect(await A.mfaChallengeAction(null, fd("123456"))).toMatchObject({ ok: false, error: expect.stringContaining("requires a passkey") });
    expect(h.verifyMfa).not.toHaveBeenCalled();
    h.getMfaPending.mockResolvedValue({ personId: "p", mode: "verify", next: "/", hasPasskey: false, passkeyRequired: true });
    h.upgrade = true;
    await expect(A.mfaChallengeAction(null, fd("123456"))).rejects.toThrow("REDIRECT:/mfa");
    expect(h.verifyMfa).toHaveBeenCalledWith("p", "123456");
    expect(h.completeMfaChallenge).not.toHaveBeenCalled();
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

describe("passkey actions: sign-in step", () => {
  it("login options/verify need pending verify mode (and a passkey for options)", async () => {
    h.getMfaPending.mockResolvedValue(null);
    expect((await A.passkeyLoginOptionsAction()).ok).toBe(false);
    h.getMfaPending.mockResolvedValue({ personId: "p", mode: "verify", next: "/", hasPasskey: false });
    expect((await A.passkeyLoginOptionsAction()).ok).toBe(false);
    h.getMfaPending.mockResolvedValue({ personId: "p", mode: "enroll", next: "/", hasPasskey: true });
    expect((await A.passkeyLoginVerifyAction({} as never)).ok).toBe(false);
    expect(h.finishPasskeyAuthentication).not.toHaveBeenCalled();
    h.getMfaPending.mockResolvedValue({ personId: "p", mode: "verify", next: "/", hasPasskey: true });
    h.beginPasskeyAuthentication.mockResolvedValue({ challenge: "c" });
    expect(await A.passkeyLoginOptionsAction()).toEqual({ ok: true, data: { challenge: "c" } });
    expect(h.beginPasskeyAuthentication).toHaveBeenCalledWith("admin", "p");
  });
  it("login verify releases the session and returns a sanitised next; expired parked session errors", async () => {
    h.getMfaPending.mockResolvedValue({ personId: "p", mode: "verify", next: "/", hasPasskey: true });
    h.completeMfaChallenge.mockResolvedValueOnce("//evil.com");
    expect(await A.passkeyLoginVerifyAction({ id: "x" } as never)).toEqual({ ok: true, data: { next: "/" } });
    expect(h.finishPasskeyAuthentication).toHaveBeenCalledWith("admin", "p", { id: "x" });
    h.completeMfaChallenge.mockResolvedValueOnce(null);
    expect((await A.passkeyLoginVerifyAction({} as never)).ok).toBe(false);
  });
  it("a failed assertion does not release the session; a clone alert is written to the admin audit log", async () => {
    h.getMfaPending.mockResolvedValue({ personId: "p", mode: "verify", next: "/", hasPasskey: true });
    h.finishPasskeyAuthentication.mockRejectedValue(new DomainError("unauthenticated", "bad"));
    expect(await A.passkeyLoginVerifyAction({} as never)).toMatchObject({ ok: false });
    expect(h.writeAudit).not.toHaveBeenCalled();
    h.finishPasskeyAuthentication.mockRejectedValue(new DomainError("unauthenticated", "copied", { cloneSuspected: true, passkeyId: "k1" }));
    expect(await A.passkeyLoginVerifyAction({} as never)).toMatchObject({ ok: false, error: "copied" });
    expect(h.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ staffId: "staff-1", privilege: "self", action: "passkey.clone_suspected", details: { passkeyId: "k1" } }));
    expect(h.completeMfaChallenge).not.toHaveBeenCalled();
  });
  it("forced enrollment only in passkey_enroll mode; registers, audits and releases", async () => {
    h.getMfaPendingAccount.mockResolvedValue({ personId: "p", account: "a@b.c", mode: "verify" });
    expect((await A.passkeyEnrollOptionsAction()).ok).toBe(false);
    expect((await A.passkeyEnrollVerifyAction({} as never, "n")).ok).toBe(false);
    h.getMfaPendingAccount.mockResolvedValue({ personId: "p", account: "a@b.c", mode: "passkey_enroll" });
    h.beginPasskeyRegistration.mockResolvedValue({ challenge: "c" });
    expect(await A.passkeyEnrollOptionsAction()).toEqual({ ok: true, data: { challenge: "c" } });
    expect(h.beginPasskeyRegistration).toHaveBeenCalledWith("admin", "p", "a@b.c");
    h.finishPasskeyRegistration.mockResolvedValue({ id: "k1" });
    h.completeMfaChallenge.mockResolvedValue("/dash");
    expect(await A.passkeyEnrollVerifyAction({ id: "r" } as never, "Laptop")).toEqual({ ok: true, data: { next: "/dash" } });
    expect(h.finishPasskeyRegistration).toHaveBeenCalledWith("admin", "p", { id: "r" }, "Laptop");
    expect(h.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "passkey.registered", details: { passkeyId: "k1", forced: true } }));
    h.completeMfaChallenge.mockResolvedValue(null);
    expect((await A.passkeyEnrollVerifyAction({} as never, "n")).ok).toBe(false);
  });
});

describe("passkey actions: account settings", () => {
  const rows: Array<[string, () => Promise<unknown>]> = [
    ["list", () => A.passkeyListAction()],
    ["stepUpOptions", () => A.passkeyStepUpOptionsAction()],
    ["registerOptions", () => A.passkeyRegisterOptionsAction({ code: "1" })],
    ["registerVerify", () => A.passkeyRegisterVerifyAction({} as never, "n")],
    ["rename", () => A.passkeyRenameAction("k", "n")],
    ["revoke", () => A.passkeyRevokeAction("k", { code: "1" })],
  ];
  it.each(rows)("%s rejects when signed out", async (_n, call) => {
    h.currentSession.mockResolvedValue(null);
    expect(await call()).toMatchObject({ ok: false });
    for (const k of ["listPasskeys", "beginPasskeyAuthentication", "verifyPasskeyStepUp", "beginPasskeyRegistration", "finishPasskeyRegistration", "renamePasskey", "revokePasskey"]) expect((h as never)[k]).not.toHaveBeenCalled();
  });
  it("delegates with the session's person and realm, auditing admin changes", async () => {
    h.currentSession.mockResolvedValue({ personId: "p", email: "e@x.y" });
    h.passkeyPolicy.mockResolvedValue({ enabled: true, required: true, hasPasskey: true });
    h.listPasskeys.mockResolvedValue([{ id: "k1" }]);
    expect(await A.passkeyListAction()).toEqual({ ok: true, data: { enabled: true, required: true, passkeys: [{ id: "k1" }] } });
    h.beginPasskeyAuthentication.mockResolvedValue({ challenge: "c" });
    expect(await A.passkeyStepUpOptionsAction()).toEqual({ ok: true, data: { challenge: "c" } });
    h.beginPasskeyRegistration.mockResolvedValue({ challenge: "r" });
    expect(await A.passkeyRegisterOptionsAction({ code: "123" })).toEqual({ ok: true, data: { challenge: "r" } });
    expect(h.verifyPasskeyStepUp).toHaveBeenCalledWith("admin", "p", { code: "123" });
    expect(h.beginPasskeyRegistration).toHaveBeenCalledWith("admin", "p", "e@x.y");
    h.finishPasskeyRegistration.mockResolvedValue({ id: "k2" });
    await A.passkeyRegisterVerifyAction({} as never, "Key");
    await A.passkeyRenameAction("k2", "New");
    await A.passkeyRevokeAction("k2", { code: "1" });
    expect(h.renamePasskey).toHaveBeenCalledWith("admin", "p", "k2", "New");
    expect(h.revokePasskey).toHaveBeenCalledWith("admin", "p", "k2", { code: "1" });
    expect(h.writeAudit.mock.calls.map((c) => c[0].action)).toEqual(["passkey.registered", "passkey.renamed", "passkey.revoked"]);
  });
  it("registerOptions stops at a failed step-up; a session without email uses the person id", async () => {
    h.currentSession.mockResolvedValue({ personId: "p" });
    h.verifyPasskeyStepUp.mockRejectedValue(new DomainError("unauthenticated", "no"));
    expect((await A.passkeyRegisterOptionsAction({ code: "1" })).ok).toBe(false);
    expect(h.beginPasskeyRegistration).not.toHaveBeenCalled();
    h.verifyPasskeyStepUp.mockResolvedValue(undefined);
    await A.passkeyRegisterOptionsAction({ code: "1" });
    expect(h.beginPasskeyRegistration).toHaveBeenCalledWith("admin", "p", "p");
  });
  it("other realms skip the admin audit log; audit failures never break the action; a clone alert on revoke is audited", async () => {
    h.currentSession.mockResolvedValue({ personId: "p" });
    h.realm = "seller";
    await A.passkeyRenameAction("k", "n");
    expect(h.writeAudit).not.toHaveBeenCalled();
    h.realm = "admin";
    h.writeAudit.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await A.passkeyRenameAction("k", "n")).ok).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    h.writeAudit.mockReset();
    h.revokePasskey.mockRejectedValue(new DomainError("unauthenticated", "copied", { cloneSuspected: true, passkeyId: "k9" }));
    expect((await A.passkeyRevokeAction("k", { code: "1" })).ok).toBe(false);
    expect(h.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "passkey.clone_suspected" }));
    h.revokePasskey.mockRejectedValue(new DomainError("not_found", "x"));
    h.writeAudit.mockReset();
    expect((await A.passkeyRevokeAction("k", { code: "1" })).ok).toBe(false);
    expect(h.writeAudit).not.toHaveBeenCalled();
  });
});
