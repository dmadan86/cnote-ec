import { beforeEach, describe, expect, it, vi } from "vitest";

const rl = vi.fn(async (..._a: unknown[]) => true);
vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), rateLimit: (...a: unknown[]) => (rl as (...x: unknown[]) => unknown)(...a) }));
const handle = vi.fn(async (..._a: unknown[]): Promise<{ status: number; duplicate?: boolean }> => ({ status: 200 }));
vi.mock("@cnote/billing", () => ({ handlePaymentWebhook: (...a: unknown[]) => (handle as (...x: unknown[]) => unknown)(...a) }));
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
const app = createApp({ health: async () => ({ postgres: true, redis: true }) });
const post = (p: string, body = "{}", h: Record<string, string> = {}) => app.request(p, { method: "POST", body, headers: h });

beforeEach(() => {
  rl.mockResolvedValue(true);
  handle.mockResolvedValue({ status: 200 });
});

describe("POST /webhooks/payments/:provider", () => {
  it("passes the raw body and headers to billing and answers 200", async () => {
    const r = await post("/webhooks/payments/razorpay", '{"a": 1}', { "x-razorpay-signature": "s" });
    expect(r.status).toBe(200);
    const [prov, raw, headers] = handle.mock.calls[0] as unknown as [string, Uint8Array, Headers];
    expect(prov).toBe("razorpay");
    expect(Buffer.from(raw).toString()).toBe('{"a": 1}');
    expect(headers.get("x-razorpay-signature")).toBe("s");
  });
  it("maps 401/400 from billing, unknown provider 404, rate limit 429, oversize 413, infra error 503", async () => {
    handle.mockResolvedValueOnce({ status: 401 });
    expect((await post("/webhooks/payments/cashfree")).status).toBe(401);
    handle.mockResolvedValueOnce({ status: 400 });
    expect((await post("/webhooks/payments/cashfree")).status).toBe(400);
    expect((await post("/webhooks/payments/paypal")).status).toBe(404);
    rl.mockResolvedValueOnce(false);
    expect((await post("/webhooks/payments/razorpay")).status).toBe(429);
    expect((await post("/webhooks/payments/razorpay", "x", { "content-length": "999999" })).status).toBe(413);
    expect((await post("/webhooks/payments/razorpay", "x".repeat(260_000))).status).toBe(413);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    handle.mockRejectedValueOnce(new Error("db down"));
    expect((await post("/webhooks/payments/razorpay")).status).toBe(503);
    err.mockRestore();
  });
});
