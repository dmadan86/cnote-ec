import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const rl = vi.fn(async (..._a: unknown[]) => true);
vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), rateLimit: (...a: unknown[]) => (rl as (...x: unknown[]) => unknown)(...a) }));
const receive = vi.fn(async (..._a: unknown[]): Promise<{ status: number; body: unknown }> => ({ status: 200, body: { message: { ack: { status: "ACK" } } } }));
const enabled = vi.fn(() => true);
const sub = vi.fn((..._a: unknown[]) => ({ status: 200, body: { answer: "a" } as unknown }));
const site = vi.fn((): string | null => "<html>ok</html>");
vi.mock("@cnote/ondc", () => ({
  isEnabled: () => enabled(),
  INBOUND_ACTIONS: ["search", "select", "init", "confirm", "status", "cancel", "issue", "issue_status"],
  ERROR_CODES: { unavailable: { type: "POLICY-ERROR", code: "20000", message: "x" }, badRequest: { type: "JSON-SCHEMA-ERROR", code: "10000", message: "y" } },
  nack: (e: { code: string }, d?: string) => ({ message: { ack: { status: "NACK" } }, error: { code: e.code, message: d } }),
  receiveInbound: (...a: unknown[]) => (receive as (...x: unknown[]) => unknown)(...a),
  handleOnSubscribe: (...a: unknown[]) => sub(...a),
  siteVerification: () => site(),
}));

const { ondcRoutes } = await import("../src/routes/ondc");
const app = new Hono();
app.route("/", ondcRoutes as never);
const post = (path: string, body = "{}", headers: Record<string, string> = {}) => app.request(path, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });

beforeEach(() => { rl.mockResolvedValue(true); enabled.mockReturnValue(true); receive.mockClear(); site.mockReturnValue("<html>ok</html>"); });

describe("ONDC routes", () => {
  it("forwards raw body and Authorization to the module and relays status/body", async () => {
    const r = await post("/ondc/search", '{"a":1}', { authorization: "Signature x" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ message: { ack: { status: "ACK" } } });
    expect(receive.mock.calls[0]![0]).toEqual({ action: "search", rawBody: '{"a":1}', authorization: "Signature x" });
    receive.mockResolvedValueOnce({ status: 401, body: { message: { ack: { status: "NACK" } } } });
    expect((await post("/ondc/select")).status).toBe(401);
  });
  it("forwards the gateway signature and accepts IGM actions", async () => {
    await post("/ondc/search", "{}", { authorization: "Signature a", "x-gateway-authorization": "Signature g" });
    expect(receive.mock.calls.at(-1)![0]).toMatchObject({ action: "search", authorization: "Signature a", gatewayAuthorization: "Signature g" });
    expect((await post("/ondc/issue")).status).toBe(200);
    expect((await post("/ondc/issue_status")).status).toBe(200);
  });
  it("404s when disabled or for unknown actions", async () => {
    enabled.mockReturnValue(false);
    expect((await post("/ondc/search")).status).toBe(404);
    expect((await post("/on_subscribe")).status).toBe(404);
    expect(receive).not.toHaveBeenCalled();
    enabled.mockReturnValue(true);
    expect((await post("/ondc/bogus")).status).toBe(404);
  });
  it("rate limits, bounds payloads and turns crashes into a retryable NACK", async () => {
    rl.mockResolvedValueOnce(false);
    const r = await post("/ondc/search");
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect((await post("/ondc/search", "{}", { "content-length": "999999" })).status).toBe(413);
    vi.spyOn(console, "error").mockImplementation(() => {});
    receive.mockRejectedValueOnce(new Error("db"));
    const c = await post("/ondc/confirm");
    expect(c.status).toBe(503);
    expect((await c.json() as { message: { ack: { status: string } } }).message.ack.status).toBe("NACK");
  });
  it("on_subscribe answers, rate limits, and rejects bad payloads", async () => {
    expect(await (await post("/on_subscribe", '{"subscriber_id":"s","challenge":"c"}')).json()).toEqual({ answer: "a" });
    expect(sub.mock.calls.at(-1)![0]).toEqual({ subscriber_id: "s", challenge: "c" });
    await post("/on_subscribe", "not json");
    expect(sub.mock.calls.at(-1)![0]).toBeNull();
    expect((await post("/on_subscribe", "x".repeat(10_001))).status).toBe(413);
    rl.mockResolvedValueOnce(false);
    expect((await post("/on_subscribe")).status).toBe(429);
  });
  it("serves the site verification page", async () => {
    const r = await app.request("/ondc-site-verification.html");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("<html>ok</html>");
    site.mockReturnValue(null);
    expect((await app.request("/ondc-site-verification.html")).status).toBe(404);
  });
});
