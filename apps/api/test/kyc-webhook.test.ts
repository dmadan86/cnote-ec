import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@cnote/core";

const rl = vi.fn(async (..._a: unknown[]) => true);
vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), rateLimit: (...a: unknown[]) => (rl as (...x: unknown[]) => unknown)(...a) }));
const handle = vi.fn(async (..._a: unknown[]): Promise<{ sessionId: string | null; status: string }> => ({ sessionId: "s", status: "approved" }));
vi.mock("@cnote/identity", () => ({ getTrustProfiles: vi.fn(async () => new Map()), handleKycWebhook: (...a: unknown[]) => (handle as (...x: unknown[]) => unknown)(...a) }));
vi.mock("@cnote/catalogue", () => ({}));
vi.mock("@cnote/billing", () => ({}));
vi.mock("@cnote/reviews", () => ({}));
vi.mock("@cnote/wishlist", () => ({}));
vi.mock("@cnote/search", () => ({}));
vi.mock("@cnote/enquiry", () => ({}));
vi.mock("@cnote/bulk", () => ({}));
vi.mock("@cnote/developer", () => ({ SCOPES: [], hasScope: () => true, verifyApiKey: vi.fn(async () => null) }));

const { createApp } = await import("../src/app");
const app = createApp({ health: async () => ({ postgres: true, redis: true }) });
const post = (body = '{"providerRef":"r"}', headers: Record<string, string> = {}) => app.request("/webhooks/kyc", { method: "POST", body, headers: { "content-type": "application/json", "x-kyc-signature": "sig", ...headers } });

beforeEach(() => { rl.mockResolvedValue(true); handle.mockResolvedValue({ sessionId: "s", status: "approved" }); });

describe("POST /webhooks/kyc", () => {
  it("passes raw body + headers to identity and answers 200 without an API key", async () => {
    const r = await post();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, status: "approved" });
    expect(handle.mock.calls[0]![0]).toBe('{"providerRef":"r"}');
    expect((handle.mock.calls[0]![1] as Record<string, string>)["x-kyc-signature"]).toBe("sig");
  });
  it("maps domain errors: 401 signature, 400 malformed, 200 ignored on conflict, 503 otherwise", async () => {
    handle.mockRejectedValueOnce(new DomainError("forbidden", "x"));
    expect((await post()).status).toBe(401);
    handle.mockRejectedValueOnce(new DomainError("validation", "x"));
    expect((await post()).status).toBe(400);
    handle.mockRejectedValueOnce(new DomainError("conflict", "expired"));
    expect(await (await post()).json()).toEqual({ ok: true, status: "ignored" });
    handle.mockRejectedValueOnce(new DomainError("not_found", "x"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await post()).status).toBe(503);
    handle.mockRejectedValueOnce(new Error("db down"));
    expect((await post()).status).toBe(503);
  });
  it("rate limits by IP and rejects oversized bodies", async () => {
    rl.mockResolvedValueOnce(false);
    const r = await post(undefined, { "x-forwarded-for": "9.9.9.9" });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect((await post(undefined, { "content-length": "999999" })).status).toBe(413);
    expect((await post("x".repeat(100_001))).status).toBe(413);
  });
});
