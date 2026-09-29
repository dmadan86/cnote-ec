import { redis } from "@cnote/core";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ isMfaEnabled: vi.fn(), headers: new Headers(), setMailer: vi.fn(), createQueuedMailer: vi.fn(() => "MAILER") }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => h.headers }));
vi.mock("@cnote/identity", async (orig) => ({ ...(await orig<object>()), isMfaEnabled: h.isMfaEnabled, setMailer: h.setMailer }));
vi.mock("@cnote/admin", () => ({ getStaff: async () => null }));
vi.mock("@cnote/email", () => ({ createQueuedMailer: h.createQueuedMailer }));

import { enforceMfaEnrolled, getNonce, NONCE_HEADER } from "../src/security";

const sub = () => `mfa-sub-${Math.random().toString(36).slice(2)}`;
const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
const req = (path: string, access?: string) => new NextRequest(`https://admin.test${path}`, { headers: access ? { cookie: `cnote_admin_at=${access}` } : {} });
const opts = { exemptPrefixes: ["/mfa", "/signin"], redirectTo: "/mfa" };
const keys: string[] = [];

beforeEach(() => {
  vi.stubEnv("CNOTE_AUTH_REALM", "admin");
  h.isMfaEnabled.mockReset();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (keys.length) await redis.del(...keys.splice(0));
});

describe("getNonce", () => {
  it("reads x-nonce, undefined when absent", async () => {
    h.headers = new Headers({ [NONCE_HEADER]: "n1" });
    expect(await getNonce()).toBe("n1");
    h.headers = new Headers();
    expect(await getNonce()).toBeUndefined();
  });
});

describe("enforceMfaEnrolled", () => {
  it("exempt paths, no cookie, garbage or sub-less tokens are none of its business", async () => {
    expect(await enforceMfaEnrolled(req("/mfa/x", jwt({ sub: "s" })), opts)).toBeNull();
    expect(await enforceMfaEnrolled(req("/"), opts)).toBeNull();
    expect(await enforceMfaEnrolled(req("/", "garbage"), opts)).toBeNull();
    expect(await enforceMfaEnrolled(req("/", jwt({})), opts)).toBeNull();
    expect(h.isMfaEnabled).not.toHaveBeenCalled();
  });
  it("redirects an un-enrolled staff session to enrollment", async () => {
    const s = sub();
    h.isMfaEnabled.mockResolvedValue(false);
    const res = await enforceMfaEnrolled(req("/dash", jwt({ sub: s })), opts);
    expect(res?.status).toBe(307);
    expect(new URL(res!.headers.get("location")!).pathname).toBe("/mfa");
  });
  it("enrolled: passes and caches the positive answer in Redis (cache hit skips DB)", async () => {
    const s = sub();
    keys.push(`mfa:on:${s}`);
    h.isMfaEnabled.mockResolvedValue(true);
    expect(await enforceMfaEnrolled(req("/dash", jwt({ sub: s })), opts)).toBeNull();
    expect(await redis.get(`mfa:on:${s}`)).toBe("1");
    expect(await enforceMfaEnrolled(req("/dash", jwt({ sub: s })), opts)).toBeNull();
    expect(h.isMfaEnabled).toHaveBeenCalledTimes(1);
  });
  it("does not cache a negative result", async () => {
    const s = sub();
    keys.push(`mfa:on:${s}`);
    h.isMfaEnabled.mockResolvedValue(false);
    await enforceMfaEnrolled(req("/dash", jwt({ sub: s })), opts);
    expect(await redis.get(`mfa:on:${s}`)).toBeNull();
  });
  it("MFA_ADMIN_OPTIONAL bypass only outside production", async () => {
    const s = sub();
    h.isMfaEnabled.mockResolvedValue(false);
    vi.stubEnv("MFA_ADMIN_OPTIONAL", "1");
    expect(await enforceMfaEnrolled(req("/dash", jwt({ sub: s })), opts)).toBeNull();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CNOTE_AUTH_REALM", "admin");
    const access = jwt({ sub: s });
    const r = new NextRequest("https://admin.test/dash", { headers: { cookie: `__Host-cnote_admin_at=${access}` } });
    expect((await enforceMfaEnrolled(r, opts))?.status).toBe(307);
  });
  it("Redis down: falls back to the database", async () => {
    const s = sub();
    h.isMfaEnabled.mockResolvedValue(true);
    vi.spyOn(redis, "get").mockRejectedValueOnce(new Error("down"));
    vi.spyOn(redis, "set").mockRejectedValueOnce(new Error("down"));
    expect(await enforceMfaEnrolled(req("/dash", jwt({ sub: s })), opts)).toBeNull();
    expect(h.isMfaEnabled).toHaveBeenCalledWith(s);
    vi.restoreAllMocks();
  });
});

describe("bootstrap", () => {
  it("installs the queued mailer once (idempotent across imports)", async () => {
    (globalThis as Record<symbol, unknown>)[Symbol.for("cnote.next-kit.bootstrapped")] = undefined;
    vi.resetModules();
    const m = await import("../src/bootstrap");
    expect(h.setMailer).toHaveBeenCalledWith("MAILER");
    m.bootstrap();
    m.bootstrap();
    expect(h.setMailer).toHaveBeenCalledTimes(1);
  });
});
