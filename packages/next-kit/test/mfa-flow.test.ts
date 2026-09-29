import { redis } from "@cnote/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeJar } from "./helpers";

const h = vi.hoisted(() => ({
  jar: null as unknown as ReturnType<typeof import("./helpers").makeJar>,
  isMfaEnabled: vi.fn(),
  getSession: vi.fn(),
  signOut: vi.fn(),
  beginMfaEnrollment: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => h.jar.store }));
vi.mock("@cnote/identity", async (orig) => ({ ...(await orig<object>()), ...h }));
vi.mock("@cnote/admin", () => ({ getStaff: async () => null }));

import { beginMfaChallenge, completeMfaChallenge, discardMfaChallenge, getMfaEnrollmentInfo, getMfaPending, mfaPendingCookieName, mfaRequirement, MFA_PATH } from "../src/mfa-flow";

const tokens = () => ({ accessToken: "AT", refreshToken: "RT-" + Math.random(), accessExpiresAt: new Date(), refreshExpiresAt: new Date(Date.now() + 1e6), personId: "person-" + Math.random().toString(36).slice(2) }) as never as import("@cnote/identity").AuthTokens;
const created: string[] = [];
async function begin(t = tokens(), next: string | null = "/dash") {
  const r = await beginMfaChallenge(t, next);
  if (r) {
    created.push(`mfa:pending:${r.cookie.value}`);
    h.jar.map.set(r.cookie.name, r.cookie.value);
  }
  return { r, t };
}

beforeEach(() => {
  vi.stubEnv("CNOTE_AUTH_REALM", "admin");
  h.jar = makeJar();
  h.isMfaEnabled.mockReset().mockResolvedValue(true);
  h.getSession.mockReset().mockResolvedValue({ email: "a@b.c" });
  h.signOut.mockReset();
  h.beginMfaEnrollment.mockReset();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (created.length) await redis.del(...created.splice(0));
});

describe("mfaRequirement", () => {
  it("verify when enrolled (any realm)", async () => {
    vi.stubEnv("CNOTE_AUTH_REALM", "seller");
    expect(await mfaRequirement("p")).toBe("verify");
  });
  it("admin unenrolled must enroll; non-admin unenrolled skips", async () => {
    h.isMfaEnabled.mockResolvedValue(false);
    expect(await mfaRequirement("p")).toBe("enroll");
    vi.stubEnv("CNOTE_AUTH_REALM", "web");
    expect(await mfaRequirement("p")).toBeNull();
  });
  it("MFA_ADMIN_OPTIONAL only outside production", async () => {
    h.isMfaEnabled.mockResolvedValue(false);
    vi.stubEnv("MFA_ADMIN_OPTIONAL", "1");
    expect(await mfaRequirement("p")).toBeNull();
    vi.stubEnv("NODE_ENV", "production");
    expect(await mfaRequirement("p")).toBe("enroll");
  });
});

describe("beginMfaChallenge", () => {
  it("returns null when no second factor is due", async () => {
    vi.stubEnv("CNOTE_AUTH_REALM", "web");
    h.isMfaEnabled.mockResolvedValue(false);
    expect(await beginMfaChallenge(tokens(), "/x")).toBeNull();
  });
  it("parks tokens encrypted in Redis (no plaintext), returns opaque httpOnly cookie", async () => {
    const { r, t } = await begin(tokens(), "/dash");
    expect(r!.path).toBe(MFA_PATH);
    expect(r!.cookie).toMatchObject({ name: "cnote_admin_mfa", httpOnly: true, sameSite: "lax", secure: false, path: "/", maxAge: 300 });
    const raw = (await redis.get(`mfa:pending:${r!.cookie.value}`))!;
    expect(raw).not.toContain(t.refreshToken);
    expect(raw).not.toContain(t.personId);
    expect(await redis.ttl(`mfa:pending:${r!.cookie.value}`)).toBeGreaterThan(290);
  });
  it("production cookie is __Host- and secure; next sanitised", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(mfaPendingCookieName()).toBe("__Host-cnote_admin_mfa");
    const { r } = await begin(tokens(), "//evil.com");
    expect(r!.cookie.secure).toBe(true);
    h.jar.map.set(mfaPendingCookieName(), r!.cookie.value);
    expect((await getMfaPending())!.next).toBe("/");
  });
  it("falls back to personId as account label when session has no email", async () => {
    h.getSession.mockResolvedValue(null);
    h.isMfaEnabled.mockResolvedValueOnce(true).mockResolvedValue(false); // requirement=verify, later enrolment info
    const t = tokens();
    const { r } = await begin(t);
    expect(r).not.toBeNull();
  });
  it("ids are unique and unguessable length", async () => {
    const a = await begin();
    const b = await begin();
    expect(a.r!.cookie.value).not.toBe(b.r!.cookie.value);
    expect(a.r!.cookie.value.length).toBeGreaterThanOrEqual(43);
  });
});

describe("getMfaPending / completeMfaChallenge", () => {
  it("exposes no secrets", async () => {
    const { t } = await begin(tokens(), "/dash?a=1");
    const v = await getMfaPending();
    expect(v).toEqual({ personId: t.personId, mode: "verify", next: "/dash?a=1" });
    expect(JSON.stringify(v)).not.toContain("RT");
  });
  it("null without cookie, with unknown id, with oversized id", async () => {
    expect(await getMfaPending()).toBeNull();
    h.jar.map.set("cnote_admin_mfa", "nope");
    expect(await getMfaPending()).toBeNull();
    h.jar.map.set("cnote_admin_mfa", "x".repeat(101));
    expect(await getMfaPending()).toBeNull();
  });
  it("tampered or foreign-context ciphertext is rejected", async () => {
    const a = await begin();
    const b = await begin();
    // Copy A's blob under B's key: AAD binds to id so decryption must fail.
    await redis.set(`mfa:pending:${b.r!.cookie.value}`, (await redis.get(`mfa:pending:${a.r!.cookie.value}`))!);
    expect(await getMfaPending()).toBeNull();
    await redis.set(`mfa:pending:${b.r!.cookie.value}`, "garbage");
    expect(await getMfaPending()).toBeNull();
  });
  it("complete is single-use: sets real cookies once, clears pending cookie", async () => {
    const { t } = await begin(tokens(), "/dash");
    expect(await completeMfaChallenge()).toBe("/dash");
    expect(h.jar.map.get("cnote_admin_at")).toBe(t.accessToken);
    expect(h.jar.map.get("cnote_admin_rt")).toBe(t.refreshToken);
    expect(h.jar.map.has("cnote_admin_mfa")).toBe(false);
    // replay with the same cookie value
    h.jar.map.clear();
    const stale = created[created.length - 1]!.replace("mfa:pending:", "");
    h.jar.map.set("cnote_admin_mfa", stale);
    expect(await completeMfaChallenge()).toBeNull();
    expect(h.jar.map.has("cnote_admin_at")).toBe(false);
  });
  it("complete with no pending returns null and issues nothing", async () => {
    expect(await completeMfaChallenge()).toBeNull();
    expect(h.jar.map.size).toBe(0);
  });
});

describe("discardMfaChallenge", () => {
  it("revokes the parked session and forgets it", async () => {
    const { t } = await begin();
    await discardMfaChallenge();
    expect(h.signOut).toHaveBeenCalledWith(t.refreshToken, "admin");
    expect(await getMfaPending()).toBeNull();
    expect(h.jar.map.has("cnote_admin_mfa")).toBe(false);
  });
  it("is a no-op without pending", async () => {
    await discardMfaChallenge();
    expect(h.signOut).not.toHaveBeenCalled();
  });
});

describe("getMfaEnrollmentInfo", () => {
  it("null unless pending in enroll mode", async () => {
    expect(await getMfaEnrollmentInfo()).toBeNull();
    await begin(); // verify mode
    expect(await getMfaEnrollmentInfo()).toBeNull();
  });
  it("returns setup info for enroll mode, done once enabled", async () => {
    h.isMfaEnabled.mockResolvedValue(false);
    await begin();
    h.beginMfaEnrollment.mockResolvedValue({ otpauthUri: "otpauth://x", manualKey: "KEY" });
    expect(await getMfaEnrollmentInfo()).toEqual({ otpauthUri: "otpauth://x", manualKey: "KEY" });
    expect(h.beginMfaEnrollment).toHaveBeenCalledWith(expect.any(String), "a@b.c");
    h.isMfaEnabled.mockResolvedValue(true);
    expect(await getMfaEnrollmentInfo()).toEqual({ done: true });
  });
});
