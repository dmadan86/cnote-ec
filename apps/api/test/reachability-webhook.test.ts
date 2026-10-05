import { beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "@cnote/core";

const rl = vi.fn(async (..._a: unknown[]) => true);
vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), rateLimit: (...a: unknown[]) => (rl as (...x: unknown[]) => unknown)(...a) }));
const handle = vi.fn(async (..._a: unknown[]): Promise<{ checkId: string | null; outcome: string }> => ({ checkId: "c", outcome: "confirmed" }));
vi.mock("@cnote/enquiry", () => ({ handleReachabilityCallback: (...a: unknown[]) => (handle as (...x: unknown[]) => unknown)(...a) }));
vi.mock("@cnote/identity", () => ({ getTrustProfiles: vi.fn(async () => new Map()) }));
vi.mock("@cnote/catalogue", () => ({}));
vi.mock("@cnote/billing", () => ({}));
vi.mock("@cnote/reviews", () => ({}));
vi.mock("@cnote/wishlist", () => ({}));
vi.mock("@cnote/search", () => ({}));
vi.mock("@cnote/bulk", () => ({}));
vi.mock("@cnote/developer", () => ({ SCOPES: [], hasScope: () => true, verifyApiKey: vi.fn(async () => null) }));

const { createApp } = await import("../src/app");
const app = createApp({ health: async () => ({ postgres: true, redis: true }) });

beforeEach(() => { rl.mockResolvedValue(true); handle.mockResolvedValue({ checkId: "c", outcome: "confirmed" }); handle.mockClear(); });

describe("/webhooks/reachability", () => {
  it("POST passes raw body, headers and the query to the adapter; no API key needed", async () => {
    const r = await app.request("/webhooks/reachability?check=c1&token=t", { method: "POST", body: '{"providerRef":"r"}', headers: { "x-reachability-signature": "sig" } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, outcome: "confirmed" });
    expect(handle.mock.calls[0]![0]).toBe('{"providerRef":"r"}');
    expect((handle.mock.calls[0]![1] as Record<string, string>)["x-reachability-signature"]).toBe("sig");
    expect((handle.mock.calls[0]![2] as URLSearchParams).get("check")).toBe("c1");
  });
  it("GET (Exotel Passthru) works with an empty body", async () => {
    const r = await app.request("/webhooks/reachability?check=c1&token=t&CallSid=CS1&digits=%221%22");
    expect(r.status).toBe(200);
    expect(handle.mock.calls[0]![0]).toBe("");
    expect((handle.mock.calls[0]![2] as URLSearchParams).get("CallSid")).toBe("CS1");
  });
  it("maps errors: 401 credentials, 400 malformed, 404 disabled, 429 rate limit, 503 otherwise; logs never include the URL", async () => {
    const post = () => app.request("/webhooks/reachability?token=SECRETTOKEN", { method: "POST", body: "{}" });
    handle.mockRejectedValueOnce(new DomainError("forbidden", "x"));
    expect((await post()).status).toBe(401);
    handle.mockRejectedValueOnce(new DomainError("validation", "x"));
    expect((await post()).status).toBe(400);
    handle.mockRejectedValueOnce(new DomainError("not_found", "off"));
    expect((await post()).status).toBe(404);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    handle.mockRejectedValueOnce(new Error("boom"));
    expect((await post()).status).toBe(503);
    expect(JSON.stringify(err.mock.calls)).not.toContain("SECRETTOKEN");
    rl.mockResolvedValueOnce(false);
    expect((await post()).status).toBe(429);
  });
});
