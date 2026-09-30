import { beforeEach, describe, expect, it, vi } from "vitest";

const rl = vi.fn(async (..._a: unknown[]) => true);
vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), rateLimit: (...a: unknown[]) => (rl as (...x: unknown[]) => unknown)(...a) }));
const handle = vi.fn(async (..._a: unknown[]): Promise<{ status: string }> => ({ status: "processed" }));
vi.mock("@cnote/escrow", () => ({ handleEscrowWebhook: (...a: unknown[]) => (handle as (...x: unknown[]) => unknown)(...a) }));
vi.mock("@cnote/catalogue", () => ({}));
vi.mock("@cnote/reviews", () => ({}));
vi.mock("@cnote/wishlist", () => ({}));
vi.mock("@cnote/search", () => ({}));
vi.mock("@cnote/enquiry", () => ({}));
vi.mock("@cnote/bulk", () => ({}));
vi.mock("@cnote/whatsapp", () => ({}));
vi.mock("@cnote/identity", () => ({ getTrustProfiles: vi.fn(async () => new Map()) }));
vi.mock("@cnote/developer", () => ({ SCOPES: [], hasScope: () => true, verifyApiKey: vi.fn(async () => null) }));

const { createApp } = await import("../src/app");
const { DomainError } = await import("@cnote/core");
const app = createApp({ health: async () => ({ postgres: true, redis: true }) });
const post = (p: string, body = "{}", h: Record<string, string> = {}) => app.request(p, { method: "POST", body, headers: h });

beforeEach(() => {
  rl.mockResolvedValue(true);
  handle.mockResolvedValue({ status: "processed" });
});

describe("POST /webhooks/escrow/:provider", () => {
  it("passes provider, raw body and headers to escrow and answers 200 with the status", async () => {
    const r = await post("/webhooks/escrow/mock", '{"a": 1}', { "x-escrow-signature": "s" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "processed" });
    const [prov, raw, headers] = handle.mock.calls[0] as unknown as [string, Uint8Array, Headers];
    expect(prov).toBe("mock");
    expect(Buffer.from(raw).toString()).toBe('{"a": 1}');
    expect(headers.get("x-escrow-signature")).toBe("s");
  });
  it("maps domain errors (404/401/400), rate limit 429, oversize 413, infra error 503", async () => {
    handle.mockRejectedValueOnce(new DomainError("not_found", "x"));
    expect((await post("/webhooks/escrow/paypal")).status).toBe(404);
    handle.mockRejectedValueOnce(new DomainError("unauthenticated", "x"));
    expect((await post("/webhooks/escrow/mock")).status).toBe(401);
    handle.mockRejectedValueOnce(new DomainError("validation", "x"));
    expect((await post("/webhooks/escrow/mock")).status).toBe(400);
    rl.mockResolvedValueOnce(false);
    expect((await post("/webhooks/escrow/mock")).status).toBe(429);
    expect((await post("/webhooks/escrow/mock", "x", { "content-length": "999999" })).status).toBe(413);
    expect((await post("/webhooks/escrow/mock", "x".repeat(260_000))).status).toBe(413);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    handle.mockRejectedValueOnce(new DomainError("forbidden", "x"));
    expect((await post("/webhooks/escrow/mock")).status).toBe(503);
    handle.mockRejectedValueOnce(new Error("db down"));
    expect((await post("/webhooks/escrow/mock")).status).toBe(503);
    err.mockRestore();
  });
});
