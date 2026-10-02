import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ record: vi.fn(), rate: vi.fn(), session: vi.fn(), ledger: vi.fn() }));
vi.mock("@/features/consent/ledger", () => ({ syncCookieConsentToLedger: h.ledger }));
vi.mock("@cnote/compliance", () => ({ recordCookieConsent: h.record }));
vi.mock("@cnote/core", async () => {
  class DomainError extends Error {
    constructor(public code: string, message: string, public details?: unknown) {
      super(message);
    }
  }
  return { DomainError, rateLimit: h.rate };
});
vi.mock("@cnote/next-kit", () => ({ currentSession: h.session }));

const { POST } = await import("@/app/api/consent/route");
const { DomainError } = await import("@cnote/core");

const ID = "e".repeat(32);
const valid = { consentId: ID, policyVersion: 1, analytics: true, marketing: false, gpc: false, action: "custom", locale: "en" };
const req = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("https://shop.test/api/consent", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://shop.test", "cf-connecting-ip": "198.18.0.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const setCookies = (r: Response) => r.headers.getSetCookie().join("|");

beforeEach(() => {
  h.record.mockReset().mockResolvedValue({ id: "r1", createdAt: "2026-09-30T00:00:00.000Z" });
  h.rate.mockReset().mockResolvedValue(true);
  h.session.mockReset().mockResolvedValue(null);
  h.ledger.mockReset().mockResolvedValue([]);
});

describe("POST /api/consent", () => {
  it("stores a receipt (no IP, no user agent passed) and answers 200 uncached", async () => {
    const res = await POST(req(valid, { "user-agent": "Mozilla/5.0" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(h.record).toHaveBeenCalledTimes(1);
    const [input, ctx] = h.record.mock.calls[0]!;
    expect(input).toEqual(valid);
    expect(ctx).toEqual({ personId: null, registryHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(h.record.mock.calls[0])).not.toMatch(/198\.18|Mozilla/);
  });
  it("attaches the personId when signed in", async () => {
    h.session.mockResolvedValue({ personId: "11111111-1111-4111-8111-111111111111" });
    await POST(req(valid));
    expect(h.record.mock.calls[0]![1]).toMatchObject({ personId: "11111111-1111-4111-8111-111111111111" });
  });
  it("stores the sha256 of the committed policy snapshot, computed server-side (an unknown version gets none)", async () => {
    await POST(req({ ...valid, policyVersion: 9999 }));
    expect(h.record.mock.calls[0]![1]).toEqual({ personId: null, registryHash: null });
  });
  it("passes the browser timestamp through for idempotency", async () => {
    await POST(req({ ...valid, at: 1_790_000_000 }));
    expect(h.record.mock.calls[0]![0]).toMatchObject({ at: 1_790_000_000 });
  });
  it("mirrors the choice into the account ledger only when signed in, and never fails the request over it", async () => {
    await POST(req(valid));
    expect(h.ledger).not.toHaveBeenCalled();
    h.session.mockResolvedValue({ personId: "11111111-1111-4111-8111-111111111111" });
    expect((await POST(req({ ...valid, at: 1_790_000_000 }))).status).toBe(200);
    expect(h.ledger).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", { analytics: true, marketing: false, functional: false }, { clientAt: 1_790_000_000 });
    h.ledger.mockRejectedValue(new Error("ledger down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await POST(req(valid))).status).toBe(200);
    err.mockRestore();
  });
  it("does not touch the ledger when the receipt could not be stored", async () => {
    h.session.mockResolvedValue({ personId: "11111111-1111-4111-8111-111111111111" });
    h.record.mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await POST(req(valid));
    err.mockRestore();
    expect(h.ledger).not.toHaveBeenCalled();
  });
  it("rate-limits per client IP taken from the trusted header helper, and answers 429 without storing", async () => {
    await POST(req(valid));
    expect(h.rate).toHaveBeenCalledWith("consent:198.18.0.7", 30, 600);
    h.rate.mockResolvedValue(false);
    h.record.mockClear();
    const res = await POST(req(valid));
    expect(res.status).toBe(429);
    expect(h.record).not.toHaveBeenCalled();
  });
  it("fails open when the limiter is down (a lost receipt is worse)", async () => {
    h.rate.mockRejectedValue(new Error("redis down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await POST(req(valid))).status).toBe(200);
    err.mockRestore();
  });
  it("rejects cross-origin posts, non-JSON content types, oversized and malformed bodies", async () => {
    expect((await POST(req(valid, { origin: "https://evil.test" }))).status).toBe(403);
    expect((await POST(req(valid, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await POST(req(valid, { "content-length": "5000" }))).status).toBe(413);
    expect((await POST(req("x".repeat(3000)))).status).toBe(413);
    expect((await POST(req("{not json"))).status).toBe(400);
    expect((await POST(req("[1]"))).status).toBe(400);
    expect((await POST(req("null"))).status).toBe(400);
    expect(h.record).not.toHaveBeenCalled();
  });
  it("same-origin requests without an Origin header (older browsers, keepalive) are allowed", async () => {
    const r = new NextRequest("https://shop.test/api/consent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(valid) });
    expect((await POST(r)).status).toBe(200);
  });
  it("maps validation errors from the compliance module to 400", async () => {
    h.record.mockRejectedValue(new DomainError("validation", "bad", { field: "action" }));
    const res = await POST(req({ ...valid, action: "nope" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid", field: "action" });
  });
  it("answers 503 when the receipt cannot be stored, but still expires marketing cookies on a withdrawal", async () => {
    h.record.mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await POST(req({ ...valid, action: "withdraw" }));
    expect(res.status).toBe(503);
    expect(setCookies(res)).toContain("cnote_ad_click=;");
    err.mockRestore();
  });
  it("expires the httpOnly marketing cookies when marketing is not granted, and leaves them alone when it is", async () => {
    const off = await POST(req(valid));
    const c = setCookies(off);
    expect(c).toMatch(/cnote_ad_click=;/);
    expect(c).toMatch(/cnote_vid=;/); // the server-written visitor id too
    expect(c).toMatch(/Max-Age=0/);
    expect(c).toMatch(/HttpOnly/i);
    const on = await POST(req({ ...valid, marketing: true }));
    expect(setCookies(on)).toBe("");
  });
  it("treats Sec-GPC: 1 as authoritative in addition to the client flag", async () => {
    await POST(req(valid, { "sec-gpc": "1" }));
    expect(h.record.mock.calls[0]![0]).toMatchObject({ gpc: true });
    h.record.mockClear();
    await POST(req(valid));
    expect(h.record.mock.calls[0]![0]).toMatchObject({ gpc: false });
  });
});
