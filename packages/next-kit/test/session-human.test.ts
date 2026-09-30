import { DomainError } from "@cnote/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeJar } from "./helpers";

const h = vi.hoisted(() => ({
  jar: null as unknown as ReturnType<typeof import("./helpers").makeJar>,
  headers: new Headers(),
  getSession: vi.fn(),
  verifyHuman: vi.fn(),
  logSecurityEvent: vi.fn(),
  getStaff: vi.fn(),
  redirect: vi.fn((u: string) => {
    throw new Error(`REDIRECT:${u}`);
  }),
}));
vi.mock("server-only", () => ({}));
vi.mock("react", () => ({ cache: <T,>(f: T) => f }));
vi.mock("next/headers", () => ({ cookies: async () => h.jar.store, headers: async () => h.headers }));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));
vi.mock("@cnote/identity", async (orig) => ({ ...(await orig<object>()), getSession: h.getSession }));
vi.mock("@cnote/admin", () => ({ getStaff: h.getStaff }));
vi.mock("@cnote/security", async (orig) => ({ ...(await orig<object>()), verifyHuman: h.verifyHuman, logSecurityEvent: h.logSecurityEvent }));

import { actorOf, currentSession, requestContext, requireBusiness, requireSession } from "../src/session";
import { verifyHumanOrThrow, verifyHumanTokenOrThrow } from "../src/human";

beforeEach(() => {
  vi.stubEnv("CNOTE_AUTH_REALM", "web");
  h.jar = makeJar();
  h.headers = new Headers();
  h.getSession.mockReset();
  h.verifyHuman.mockReset();
  h.logSecurityEvent.mockReset();
  h.redirect.mockClear();
  h.getStaff.mockReset();
});

describe("currentSession", () => {
  it("reads this realm's access cookie and verifies against this realm", async () => {
    h.jar.map.set("cnote_web_at", "TOK");
    h.jar.map.set("cnote_seller_at", "OTHER");
    h.getSession.mockResolvedValue({ personId: "p" });
    expect(await currentSession()).toEqual({ personId: "p" });
    expect(h.getSession).toHaveBeenCalledWith("TOK", "web");
  });
  it("passes undefined when no cookie", async () => {
    h.getSession.mockResolvedValue(null);
    expect(await currentSession()).toBeNull();
    expect(h.getSession).toHaveBeenCalledWith(undefined, "web");
  });
});

describe("requireSession / requireBusiness", () => {
  it("redirects with encoded next and custom sign-in path", async () => {
    h.getSession.mockResolvedValue(null);
    await expect(requireSession("/a?b=1&c=2")).rejects.toThrow("REDIRECT:/signin?next=%2Fa%3Fb%3D1%26c%3D2");
    await expect(requireSession("/x", { signInPath: "/login" })).rejects.toThrow("REDIRECT:/login?next=%2Fx");
  });
  it("returns the session", async () => {
    h.getSession.mockResolvedValue({ personId: "p" });
    expect(await requireSession("/x")).toEqual({ personId: "p" });
  });
  it("redirects to onboarding without a business, custom path honoured", async () => {
    h.getSession.mockResolvedValue({ personId: "p", business: null });
    await expect(requireBusiness("/dash")).rejects.toThrow("REDIRECT:/onboarding?next=%2Fdash");
    await expect(requireBusiness("/dash", { onboardingPath: "/setup" })).rejects.toThrow("REDIRECT:/setup?next=%2Fdash");
  });
  it("returns session with business and actorOf maps ids", async () => {
    h.getSession.mockResolvedValue({ personId: "p", business: { id: "b" } });
    const s = await requireBusiness("/dash");
    expect(actorOf(s)).toEqual({ personId: "p", businessId: "b" });
  });
});

describe("requestContext", () => {
  it("takes the x-forwarded-for hop our proxy added (never the client-controlled first one), then x-real-ip, else null", async () => {
    h.headers = new Headers({ "x-forwarded-for": " 1.1.1.1 , 2.2.2.2", "user-agent": "UA", "x-real-ip": "3.3.3.3" });
    expect(await requestContext()).toMatchObject({ ip: "2.2.2.2", userAgent: "UA", realm: "web" });
    h.headers = new Headers({ "x-real-ip": " 3.3.3.3 " });
    expect((await requestContext()).ip).toBe("3.3.3.3");
    h.headers = new Headers();
    expect(await requestContext()).toMatchObject({ ip: null, userAgent: null });
  });
  it("admin realm adds an admission guard backed by active staff; other realms don't", async () => {
    expect((await requestContext()).allowPerson).toBeUndefined();
    vi.stubEnv("CNOTE_AUTH_REALM", "admin");
    const ctx = await requestContext();
    h.getStaff.mockResolvedValueOnce({ id: "s" });
    expect(await ctx.allowPerson!("p")).toBe(true);
    h.getStaff.mockResolvedValueOnce(null);
    expect(await ctx.allowPerson!("p")).toBe(false);
  });
});

describe("human verification", () => {
  it("passes the first present token field and the client ip", async () => {
    h.headers = new Headers({ "x-forwarded-for": "8.8.8.8" });
    h.verifyHuman.mockResolvedValue({ ok: true });
    const fd = new FormData();
    fd.set("g-recaptcha-response", "R");
    fd.set("h-captcha-response", "H");
    await verifyHumanOrThrow(fd);
    expect(h.verifyHuman).toHaveBeenCalledWith("H", "8.8.8.8");
    const fd2 = new FormData();
    fd2.set("cf-turnstile-response", "CF");
    fd2.set("h-captcha-response", "H");
    await verifyHumanOrThrow(fd2);
    expect(h.verifyHuman).toHaveBeenLastCalledWith("CF", "8.8.8.8");
  });
  it("ignores empty tokens and passes null", async () => {
    h.verifyHuman.mockResolvedValue({ ok: true });
    const fd = new FormData();
    fd.set("cf-turnstile-response", "");
    await verifyHumanOrThrow(fd);
    expect(h.verifyHuman).toHaveBeenCalledWith(null, null);
    await verifyHumanTokenOrThrow(undefined);
    expect(h.verifyHuman).toHaveBeenLastCalledWith(null, null);
  });
  it("rejects with forbidden and logs the reason on failure", async () => {
    h.verifyHuman.mockResolvedValue({ ok: false, reason: "invalid" });
    const err = await verifyHumanTokenOrThrow("bad").catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe("forbidden");
    expect(h.logSecurityEvent).toHaveBeenCalledWith("human.rejected", { reason: "invalid", ip: null });
  });
});
