import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rl = vi.fn(async (..._a: unknown[]) => true);
vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), rateLimit: (...a: unknown[]) => (rl as (...x: unknown[]) => unknown)(...a) }));
const handleWebhook = vi.fn(async (..._a: unknown[]): Promise<{ status: number; enqueued: number }> => ({ status: 200, enqueued: 1 }));
vi.mock("@cnote/whatsapp", () => ({
  handleWebhook: (...a: unknown[]) => (handleWebhook as (...x: unknown[]) => unknown)(...a),
  verifyChallenge: (q: { mode?: string; token?: string; challenge?: string }) => (q.mode === "subscribe" && q.token === "vt" ? q.challenge ?? null : null),
}));
vi.mock("@cnote/catalogue", () => ({}));
vi.mock("@cnote/billing", () => ({}));
vi.mock("@cnote/reviews", () => ({}));
vi.mock("@cnote/wishlist", () => ({}));
vi.mock("@cnote/search", () => ({}));
vi.mock("@cnote/enquiry", () => ({}));
vi.mock("@cnote/bulk", () => ({}));
vi.mock("@cnote/identity", () => ({ getTrustProfiles: vi.fn(async () => new Map()) }));
vi.mock("@cnote/developer", () => ({ SCOPES: [], hasScope: () => true, verifyApiKey: vi.fn(async () => null) }));

const { createApp } = await import("../src/app");
const app = createApp({ health: async () => ({ postgres: true, redis: true }) });
const sig = (b: string) => `sha256=${createHmac("sha256", "x").update(b).digest("hex")}`;

beforeEach(() => {
  rl.mockResolvedValue(true);
  handleWebhook.mockResolvedValue({ status: 200, enqueued: 1 });
});

describe("GET /webhooks/whatsapp", () => {
  it("echoes the challenge for the right verify token, 403 otherwise, without an API key", async () => {
    const ok = await app.request("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=1158201444");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("1158201444");
    expect((await app.request("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=bad&hub.challenge=1")).status).toBe(403);
    expect((await app.request("/webhooks/whatsapp")).status).toBe(403);
  });
  it("is rate limited by IP", async () => {
    rl.mockResolvedValueOnce(false);
    const r = await app.request("/webhooks/whatsapp?hub.mode=subscribe", { headers: { "x-forwarded-for": "1.2.3.4" } });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(rl.mock.calls.at(-1)![0]).toContain("1.2.3.4");
  });
});

describe("POST /webhooks/whatsapp", () => {
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  it("passes the raw bytes and headers to the handler and answers 200", async () => {
    const r = await app.request("/webhooks/whatsapp", { method: "POST", body, headers: { "content-type": "application/json", "x-hub-signature-256": sig(body) } });
    expect(r.status).toBe(200);
    const [raw, headers] = handleWebhook.mock.calls[0] as unknown as [Uint8Array, Headers];
    expect(Buffer.from(raw).toString()).toBe(body);
    expect(headers.get("x-hub-signature-256")).toBe(sig(body));
  });
  it("maps handler outcomes: 401, 400, 503 on queue failure", async () => {
    handleWebhook.mockResolvedValueOnce({ status: 401, enqueued: 0 });
    expect((await app.request("/webhooks/whatsapp", { method: "POST", body })).status).toBe(401);
    handleWebhook.mockResolvedValueOnce({ status: 400, enqueued: 0 });
    expect((await app.request("/webhooks/whatsapp", { method: "POST", body })).status).toBe(400);
    handleWebhook.mockRejectedValueOnce(new Error("redis down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await app.request("/webhooks/whatsapp", { method: "POST", body })).status).toBe(503);
    vi.restoreAllMocks();
  });
  it("rate limits and rejects oversized bodies", async () => {
    rl.mockResolvedValueOnce(false);
    expect((await app.request("/webhooks/whatsapp", { method: "POST", body })).status).toBe(429);
    expect((await app.request("/webhooks/whatsapp", { method: "POST", body, headers: { "content-length": "5000000" } })).status).toBe(413);
    expect((await app.request("/webhooks/whatsapp", { method: "POST", body: "x".repeat(1_000_001) })).status).toBe(413);
  });
  it("is excluded from the OpenAPI document", async () => {
    const spec = await (await app.request("/openapi.json")).json();
    expect(Object.keys(spec.paths).some((p) => p.includes("webhooks"))).toBe(false);
  });
});
