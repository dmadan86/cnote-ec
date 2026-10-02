import { DomainError } from "@cnote/core";
import { signServiceToken } from "@cnote/ai/service-client";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { CapabilityHandlers } from "../src/capabilities";
import { loadConfig } from "../src/env";
import { buildOpenApi } from "../src/openapi";
import { AI_CAPABILITIES } from "@cnote/ai/remote";

const SECRET = "ai-service-test-secret-0123456789abcdef";
const cfg = (over = {}) => ({ port: 0, tokenSecret: SECRET, maxInflight: 8, maxBodyBytes: 1024 * 1024, ...over });
const token = (o: Partial<Parameters<typeof signServiceToken>[0]> = {}) => signServiceToken({ secret: SECRET, audience: "ai-service", issuer: "worker", ...o });
const ok = { output: { fine: true }, confidence: 0.9, provider: "stub", modelId: "m", promptVersion: "p" };
const stub = (fn: (i: any) => Promise<any> = async () => ok): CapabilityHandlers =>
  Object.fromEntries(Object.keys(AI_CAPABILITIES).map((k) => [k, fn])) as unknown as CapabilityHandlers;
const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${token()}` }) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const make = (over: Parameters<typeof createApp>[0] = {}) => createApp({ config: cfg(), handlers: stub(), log: () => {}, env: {}, ...over });

describe("probes and docs", () => {
  it("health is open; ready reports configuration problems", async () => {
    const app = make();
    expect((await app.request("/health")).status).toBe(200);
    const auth = { authorization: `Bearer ${token()}` };
    // anonymous: status only, never provider names or the problems list
    expect(await (await app.request("/ready")).json()).toEqual({ status: "ready" });
    expect(await (await app.request("/ready", { headers: { authorization: "Bearer not-a-token" } })).json()).toEqual({ status: "ready" });
    // with a valid service token: the details
    expect(await (await app.request("/ready", { headers: auth })).json()).toMatchObject({ status: "ready", provider: "heuristic", asr: "mock", capabilities: 12 });
    const bad = make({ config: cfg({ tokenSecret: "" }), env: { AI_PROVIDER: "anthropic", ASR_PROVIDER: "sarvam" } });
    const r = await bad.request("/ready");
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ status: "not_ready" });
    const withDetails = make({ env: { AI_PROVIDER: "anthropic", ASR_PROVIDER: "sarvam" } });
    const rd = await withDetails.request("/ready", { headers: auth });
    expect(rd.status).toBe(503);
    expect((await rd.json() as any).problems).toEqual(["AI_PROVIDER=anthropic but ANTHROPIC_API_KEY not set", "ASR_PROVIDER=sarvam but SARVAM_API_KEY not set"]);
    const okKeys = make({ env: { AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", ASR_PROVIDER: "sarvam", SARVAM_API_KEY: "s" } });
    expect((await okKeys.request("/ready")).status).toBe(200);
  });
  it("serves an OpenAPI document covering every capability", async () => {
    const spec = (await (await make().request("/openapi.json")).json()) as any;
    expect(spec.openapi).toBe("3.1.0");
    for (const c of Object.values(AI_CAPABILITIES)) expect(spec.paths[c.path].post).toBeDefined();
    expect(spec.paths["/v1/transcribe"].post.description).toMatch(/NO/);
    expect(buildOpenApi("9.9.9").info.version).toBe("9.9.9");
  });
  it("404s unknown routes with the error envelope", async () => {
    const r = await make().request("/nope");
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ error: { code: "not_found" } });
  });
  it("loads config from env with defaults", () => {
    expect(loadConfig({})).toEqual({ port: 3005, tokenSecret: "", maxInflight: 64, maxBodyBytes: 24 * 1024 * 1024 });
    expect(loadConfig({ PORT: "9", AI_SERVICE_TOKEN_SECRET: "s", AI_SERVICE_MAX_INFLIGHT: "2", AI_SERVICE_MAX_BODY_BYTES: "10" })).toEqual({ port: 9, tokenSecret: "s", maxInflight: 2, maxBodyBytes: 10 });
    expect(loadConfig({ PORT: "abc" }).port).toBe(3005);
  });
  it("uses process env and the in-process handlers by default", async () => {
    const app = createApp({ config: cfg(), log: () => {} });
    const r = await post(app, "/v1/moderate", { input: { text: "cotton shirts" } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ provider: "heuristic" });
  });
  it("refuses to run with AI_TRANSPORT=http (it would call itself)", () => {
    expect(() => createApp({ config: cfg(), env: { AI_TRANSPORT: "http" } })).toThrow(/inproc/);
  });
});

describe("service authentication", () => {
  it("rejects missing, malformed, wrongly signed, wrong-audience and expired tokens with 401 + WWW-Authenticate", async () => {
    const app = make();
    const cases: Record<string, string | undefined> = {
      none: undefined,
      garbage: "Bearer nope",
      wrongKey: `Bearer ${signServiceToken({ secret: "another-secret-another-secret-another", audience: "ai-service", issuer: "x" })}`,
      wrongAudience: `Bearer ${token({ audience: "search-service" })}`,
      expired: `Bearer ${token({ nowMs: Date.now() - 3_600_000 })}`,
      notBearer: `Basic ${token()}`,
    };
    for (const [name, h] of Object.entries(cases)) {
      const r = await post(app, "/v1/moderate", { input: {} }, h ? { authorization: h } : {});
      expect(r.status, name).toBe(401);
      expect(r.headers.get("www-authenticate"), name).toContain("invalid_token");
      expect(await r.json()).toMatchObject({ error: { code: "unauthorized" } });
    }
  });
  it("rejects everything when no secret is configured", async () => {
    const r = await post(make({ config: cfg({ tokenSecret: "" }) }), "/v1/moderate", { input: {} });
    expect(r.status).toBe(401);
  });
  it("accepts a token signed with the previous key during rotation", async () => {
    const old = "previous-key-previous-key-previous-key";
    const app = make({ config: cfg({ tokenSecret: `${SECRET},${old}` }) });
    const r = await post(app, "/v1/moderate", { input: {} }, { authorization: `Bearer ${signServiceToken({ secret: old, audience: "ai-service", issuer: "worker" })}` });
    expect(r.status).toBe(200);
  });
  it("logs one JSON line per request with the caller and never the payload", async () => {
    const lines: string[] = [];
    const app = make({ log: (l) => lines.push(l) });
    await post(app, "/v1/moderate", { input: { text: "call me on 9876543210" } });
    const entry = JSON.parse(lines.at(-1)!);
    expect(entry).toMatchObject({ svc: "ai-service", caller: "worker", path: "/v1/moderate", status: 200 });
    expect(lines.join("")).not.toContain("9876543210");
  });
});

describe("request handling", () => {
  it("echoes a valid X-Request-Id and generates one otherwise", async () => {
    const app = make();
    const a = await post(app, "/v1/moderate", { input: {} }, { authorization: `Bearer ${token()}`, "x-request-id": "req-12345678" });
    expect(a.headers.get("x-request-id")).toBe("req-12345678");
    const b = await post(app, "/v1/moderate", { input: {} }, { authorization: `Bearer ${token()}`, "x-request-id": "bad id!" });
    expect(b.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("validates the envelope", async () => {
    const app = make();
    for (const body of ["not json", {}, { input: [] }, { input: "x" }, { input: null }]) {
      const r = await post(app, "/v1/moderate", body);
      expect(r.status).toBe(422);
      expect(await r.json()).toMatchObject({ error: { code: "validation" } });
    }
  });
  it("validates embed input", async () => {
    const app = make();
    for (const texts of [undefined, [], "x", [1], ["a".repeat(20_001)], Array.from({ length: 257 }, () => "a")]) {
      expect((await post(app, "/v1/embed", { input: { texts } })).status).toBe(422);
    }
    expect((await post(app, "/v1/embed", { input: { texts: ["a"] } })).status).toBe(200);
  });
  it("decodes binary fields before calling the capability and encodes them in the answer", async () => {
    const seen = vi.fn(async (i: any) => ({ ...ok, output: { echo: i.audio.bytes } }));
    const r = await post(make({ handlers: stub(seen) }), "/v1/transcribe", { input: { audio: { bytes: { $base64: "AQID" }, mimeType: "audio/wav" } } });
    expect(seen.mock.calls[0]![0].audio.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(((await r.json()) as any).output.echo).toEqual({ $base64: "AQID" });
  });
  it("caps the body size", async () => {
    const r = await post(make({ config: cfg({ maxBodyBytes: 50 }) }), "/v1/moderate", { input: { text: "x".repeat(500) } });
    expect(r.status).toBe(413);
    expect(await r.json()).toMatchObject({ error: { code: "payload_too_large" } });
  });
  it("maps DomainError to its status and hides unexpected failure details", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const domain = make({ handlers: stub(async () => { throw new DomainError("validation", "Recording is longer than 5 minutes"); }) });
    const a = await post(domain, "/v1/transcribe", { input: {} });
    expect(a.status).toBe(422);
    expect(await a.json()).toMatchObject({ error: { code: "validation", message: "Recording is longer than 5 minutes" } });
    const boom = make({ handlers: stub(async () => { throw new Error("secret vendor key sk-123 leaked"); }) });
    const b = await post(boom, "/v1/moderate", { input: {} });
    expect(b.status).toBe(500);
    expect(JSON.stringify(await b.json())).not.toContain("sk-123");
    err.mockRestore();
  });
  it("sheds load with 503 + Retry-After beyond maxInflight, and recovers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const app = make({ config: cfg({ maxInflight: 1 }), handlers: stub(async () => { await gate; return ok; }) });
    const first = post(app, "/v1/moderate", { input: {} });
    await new Promise((r) => setTimeout(r, 20));
    const second = await post(app, "/v1/moderate", { input: {} });
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBe("1");
    expect((await app.request("/ready")).status).toBe(503);
    release();
    expect((await first).status).toBe(200);
    expect((await post(app, "/v1/moderate", { input: {} })).status).toBe(200);
  });
});
