import { firstParty, type StorageEntry } from "@cnote/consent";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rate: vi.fn() }));
vi.mock("@cnote/core", async (orig) => {
  class DomainError extends Error {
    constructor(public code: string, message: string, public details?: unknown) {
      super(message);
    }
  }
  return { ...(await orig<object>()), DomainError, rateLimit: h.rate };
});

const { createConsentPost, CONSENT_RATE } = await import("../src/consent-route");
const { DomainError } = await import("@cnote/core");

const REGISTRY: readonly StorageEntry[] = [
  firstParty("app_consent", "necessary", "cookie", "consent", { unit: "months", n: 12 }),
  firstParty("app_t0", "analytics", "cookie", "timing", { unit: "years", n: 1 }, true),
  firstParty("app_ref", "marketing", "cookie", "ref", { unit: "days", n: 30 }, true),
  firstParty("app_ls", "functional", "cookie", "pref", { unit: "years", n: 1 }, true),
];
const ID = "e".repeat(32);
const valid = { consentId: ID, policyVersion: 1, analytics: true, marketing: false, functional: true, gpc: false, action: "custom", locale: "en" };

const s = vi.hoisted(() => ({ record: vi.fn(), session: vi.fn(), saved: vi.fn() }));
const post = createConsentPost({
  app: "seller",
  logTag: "[t]",
  getSession: s.session,
  record: s.record,
  registryHashFor: (v) => (v === 1 ? "a".repeat(64) : null),
  registry: REGISTRY,
  onSaved: s.saved,
});

const req = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("https://seller.test/api/consent", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://seller.test", "cf-connecting-ip": "198.18.0.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const cookies = (r: Response) => r.headers.getSetCookie().join("|");

beforeEach(() => {
  s.record.mockReset().mockResolvedValue({ id: "r1" });
  s.session.mockReset().mockResolvedValue(null);
  s.saved.mockReset().mockResolvedValue(undefined);
  h.rate.mockReset().mockResolvedValue(true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("createConsentPost (shared receipts route)", () => {
  it("stores a receipt tagged with the app and the snapshot hash, never an IP or user agent, and answers 200 uncached", async () => {
    const res = await post(req(valid, { "user-agent": "Mozilla/5.0" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(s.record).toHaveBeenCalledWith(valid, { app: "seller", personId: null, registryHash: "a".repeat(64) });
    expect(JSON.stringify(s.record.mock.calls)).not.toMatch(/198\.18|Mozilla/);
    expect(h.rate).toHaveBeenCalledWith("consent:198.18.0.7", CONSENT_RATE.count, CONSENT_RATE.windowSeconds);
  });
  it("attaches the person when signed in and runs the follow-up; a failing follow-up never fails the receipt", async () => {
    s.session.mockResolvedValue({ personId: "11111111-1111-4111-8111-111111111111" });
    s.saved.mockRejectedValue(new Error("ledger down"));
    const res = await post(req(valid));
    expect(res.status).toBe(200);
    expect(s.record.mock.calls[0]![1]).toMatchObject({ personId: "11111111-1111-4111-8111-111111111111" });
    expect(s.saved).toHaveBeenCalledWith(valid, { personId: "11111111-1111-4111-8111-111111111111" });
    expect(console.error).toHaveBeenCalled();
  });
  it("does not run a follow-up for anonymous visitors, and a session lookup failure is anonymous", async () => {
    await post(req(valid));
    s.session.mockRejectedValue(new Error("boom"));
    await post(req(valid));
    expect(s.saved).not.toHaveBeenCalled();
  });
  it("has no follow-up hook by default", async () => {
    const bare = createConsentPost({ app: "web", logTag: "[t]", getSession: async () => ({ personId: "p" }), record: s.record, registryHashFor: () => null, registry: REGISTRY });
    expect((await bare(req(valid))).status).toBe(200);
  });
  it("an unknown policy version gets no hash; a non-numeric one is version 0", async () => {
    await post(req({ ...valid, policyVersion: 99 }));
    await post(req({ ...valid, policyVersion: "x" }));
    expect(s.record.mock.calls[0]![1].registryHash).toBeNull();
    expect(s.record.mock.calls[1]![1].registryHash).toBeNull();
  });
  it("Sec-GPC: 1 makes the receipt carry gpc even when the client said false", async () => {
    await post(req({ ...valid, gpc: false }, { "sec-gpc": "1" }));
    expect(s.record.mock.calls[0]![0]).toMatchObject({ gpc: true });
  });

  it("expires the httpOnly cookies of every category that is not granted, nothing else", async () => {
    const res = await post(req({ ...valid, analytics: false, marketing: false, functional: true }));
    const c = cookies(res);
    expect(c).toContain("app_t0=;");
    expect(c).toContain("app_ref=;");
    expect(c).not.toContain("app_ls=");
    expect(c).not.toContain("app_consent=");
    expect(cookies(await post(req({ ...valid, analytics: true, marketing: true, functional: true })))).toBe("");
  });
  it("withdrawal still takes effect when the receipt could not be stored (503)", async () => {
    s.record.mockRejectedValue(new Error("db down"));
    const res = await post(req({ ...valid, marketing: false }));
    expect(res.status).toBe(503);
    expect(cookies(res)).toContain("app_ref=;");
  });

  it("answers 400 with the field for a validation error and 503 for an unexpected one", async () => {
    s.record.mockRejectedValueOnce(new DomainError("validation", "bad", { field: "locale" }));
    const bad = await post(req({ ...valid, locale: "xx" }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid", field: "locale" });
    s.record.mockRejectedValueOnce(new DomainError("validation", "bad"));
    expect(await (await post(req(valid))).json()).toEqual({ error: "invalid", field: null });
    s.record.mockRejectedValueOnce(new Error("boom"));
    expect((await post(req(valid))).status).toBe(503);
  });

  it("refuses cross-origin, non-JSON, oversized and malformed requests", async () => {
    expect((await post(req(valid, { origin: "https://evil.test" }))).status).toBe(403);
    expect((await post(req(valid, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await post(req(valid, { "content-length": "99999" }))).status).toBe(413);
    expect((await post(req(JSON.stringify({ x: "a".repeat(3000) })))).status).toBe(413);
    expect((await post(req("{not json"))).status).toBe(400);
    expect((await post(req("[1]"))).status).toBe(400);
    expect((await post(req("null"))).status).toBe(400);
    expect(s.record).not.toHaveBeenCalled();
  });
  it("rate limits per client IP (429) and fails open when the limiter is down", async () => {
    h.rate.mockResolvedValueOnce(false);
    const limited = await post(req(valid));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited", retryAfterSeconds: CONSENT_RATE.windowSeconds });
    h.rate.mockRejectedValueOnce(new Error("redis down"));
    expect((await post(req(valid))).status).toBe(200);
    h.rate.mockResolvedValueOnce(true);
    const noIp = new NextRequest("https://seller.test/api/consent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(valid) });
    expect((await post(noIp)).status).toBe(200);
    expect(h.rate).toHaveBeenLastCalledWith("consent:unknown", expect.any(Number), expect.any(Number));
  });
});
