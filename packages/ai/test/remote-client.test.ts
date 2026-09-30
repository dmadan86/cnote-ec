import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker, ServiceClient, ServiceRejectedError, ServiceUnavailableError, decodeWire, encodeWire, signServiceToken, splitSecrets, verifyServiceToken,
} from "../src/service-client";

const SECRET = "k-current-0123456789abcdef0123456789";
const OLD = "k-previous-0123456789abcdef012345678";
const sign = (o: Partial<Parameters<typeof signServiceToken>[0]> = {}) => signServiceToken({ secret: SECRET, audience: "ai-service", issuer: "worker", ...o });

describe("service tokens", () => {
  it("round-trips and carries issuer, audience, short ttl and a unique jti", () => {
    const t = sign();
    const v = verifyServiceToken(t, { secret: SECRET, audience: "ai-service" });
    expect(v.ok && v.claims).toMatchObject({ iss: "worker", aud: "ai-service" });
    expect(v.ok && v.claims.exp - v.claims.iat).toBe(60);
    const a = verifyServiceToken(sign(), { secret: SECRET, audience: "ai-service" });
    const b = verifyServiceToken(sign(), { secret: SECRET, audience: "ai-service" });
    expect(a.ok && b.ok && a.claims.jti !== b.claims.jti).toBe(true);
  });
  it("rejects wrong audience, wrong key, tampering, malformed input", () => {
    const t = sign();
    expect(verifyServiceToken(t, { secret: SECRET, audience: "search-service" })).toEqual({ ok: false, reason: "audience" });
    expect(verifyServiceToken(t, { secret: "other-secret", audience: "ai-service" })).toEqual({ ok: false, reason: "signature" });
    const [tokHead, tokBody, tokSig] = t.split(".");
    expect(verifyServiceToken(`${tokHead}.${tokBody}.${aliasLastChar(tokSig!)}`, { secret: SECRET, audience: "ai-service" })).toEqual({ ok: false, reason: "signature" }); // same bytes, other spelling
    const [h, , s] = t.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ iss: "x", aud: "ai-service", iat: 1, exp: 9999999999, jti: "j" })).toString("base64url")}.${s}`;
    expect(verifyServiceToken(forged, { secret: SECRET, audience: "ai-service" })).toEqual({ ok: false, reason: "signature" });
    expect(verifyServiceToken("nope", { secret: SECRET, audience: "ai-service" })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyServiceToken(`${"x"}.${t.split(".")[1]}.${s}`, { secret: SECRET, audience: "ai-service" })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyServiceToken(`${h}.${t.split(".")[1]}.short`, { secret: SECRET, audience: "ai-service" })).toEqual({ ok: false, reason: "signature" });
  });
  it("rejects a validly signed body that is not JSON or lacks claims", async () => {
    const { createHmac } = await import("node:crypto");
    const h = t0().split(".")[0]!;
    const mk = (body: string) => { const p = `${h}.${Buffer.from(body).toString("base64url")}`; return `${p}.${createHmac("sha256", SECRET).update(p).digest("base64url")}`; };
    expect(verifyServiceToken(mk("not json"), { secret: SECRET, audience: "ai-service" })).toEqual({ ok: false, reason: "malformed" });
    expect(verifyServiceToken(mk(JSON.stringify({ aud: "ai-service" })), { secret: SECRET, audience: "ai-service" })).toEqual({ ok: false, reason: "malformed" });
  });
  it("enforces expiry (with skew), not-before and a max ttl", () => {
    const now = 1_800_000_000_000;
    const t = sign({ nowMs: now, ttlSeconds: 60 });
    expect(verifyServiceToken(t, { secret: SECRET, audience: "ai-service", nowMs: now + 64_000 }).ok).toBe(true);
    expect(verifyServiceToken(t, { secret: SECRET, audience: "ai-service", nowMs: now + 66_000 })).toEqual({ ok: false, reason: "expired" });
    expect(verifyServiceToken(t, { secret: SECRET, audience: "ai-service", nowMs: now - 10_000 })).toEqual({ ok: false, reason: "not_yet_valid" });
    const long = sign({ nowMs: now, ttlSeconds: 3600 });
    expect(verifyServiceToken(long, { secret: SECRET, audience: "ai-service", nowMs: now })).toEqual({ ok: false, reason: "ttl_too_long" });
    expect(verifyServiceToken(long, { secret: SECRET, audience: "ai-service", nowMs: now, maxTtlSeconds: 7200 }).ok).toBe(true);
  });
  it("supports key rotation: sign with the first key, verify against any", () => {
    const rotating = `${SECRET}, ${OLD}`;
    expect(splitSecrets(rotating)).toEqual([SECRET, OLD]);
    expect(verifyServiceToken(sign({ secret: OLD }), { secret: rotating, audience: "ai-service" }).ok).toBe(true);
    expect(verifyServiceToken(sign({ secret: rotating }), { secret: SECRET, audience: "ai-service" }).ok).toBe(true);
    expect(() => sign({ secret: " , " })).toThrow(/empty/);
  });
});
const t0 = () => sign();

describe("wire codec", () => {
  it("encodes bytes as {$base64} and decodes them back, recursively", () => {
    const input = { images: [{ bytes: new Uint8Array([1, 2, 255]), mimeType: "image/png" }], n: 1, s: "x", z: null, nested: { a: [new Uint8Array([9])] } };
    const wire = encodeWire(input) as any;
    expect(wire.images[0].bytes).toEqual({ $base64: "AQL/" });
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
    const back = decodeWire(JSON.parse(JSON.stringify(wire))) as any;
    expect(back.images[0].bytes).toEqual(new Uint8Array([1, 2, 255]));
    expect(back.nested.a[0]).toEqual(new Uint8Array([9]));
    expect(back.s).toBe("x");
    expect(back.z).toBeNull();
  });
  it("leaves lookalike objects with extra keys alone", () => {
    expect(decodeWire({ $base64: "AQ==", other: 1 })).toEqual({ $base64: "AQ==", other: 1 });
  });
});

describe("CircuitBreaker", () => {
  it("opens after N consecutive failures, half-opens after the cooldown with a single probe, and closes on success", () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => now });
    expect(b.state).toBe("closed");
    b.failure();
    expect(b.allow()).toBe(true);
    b.failure();
    expect(b.state).toBe("open");
    expect(b.allow()).toBe(false);
    now = 1000;
    expect(b.state).toBe("half_open");
    expect(b.allow()).toBe(true); // the probe
    expect(b.allow()).toBe(false); // everyone else waits for it
    b.failure(); // probe failed: re-open with a fresh cooldown
    expect(b.state).toBe("open");
    now = 2000;
    expect(b.allow()).toBe(true);
    b.success();
    expect(b.state).toBe("closed");
    expect(b.allow()).toBe(true);
  });
  it("a success resets the consecutive-failure count; defaults are sane", () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 4; i++) b.failure();
    b.success();
    for (let i = 0; i < 4; i++) b.failure();
    expect(b.state).toBe("closed");
    b.failure();
    expect(b.state).toBe("open");
  });
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const mk = (fetchImpl: typeof fetch, over: Partial<ConstructorParameters<typeof ServiceClient>[0]> = {}) =>
  new ServiceClient({ name: "svc", baseUrl: "http://svc.internal/", audience: "ai-service", issuer: "worker", secret: SECRET, fetchImpl, sleep: async () => {}, ...over });

afterEach(() => vi.restoreAllMocks());

describe("ServiceClient", () => {
  it("POSTs JSON with a verifiable bearer token and request id, and decodes bytes in the answer", async () => {
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe("http://svc.internal/v1/x");
      const token = String(init.headers.authorization).replace("Bearer ", "");
      expect(verifyServiceToken(token, { secret: SECRET, audience: "ai-service" }).ok).toBe(true);
      expect(init.headers["x-request-id"]).toMatch(/[0-9a-f-]{36}/);
      expect(JSON.parse(init.body)).toEqual({ input: { b: { $base64: "AQI=" } } });
      return json(200, { out: { $base64: "AwQ=" } }, { "x-request-id": "srv-1" });
    }) as unknown as typeof fetch;
    const r = await mk(fetchImpl).request<{ out: Uint8Array }>("POST", "/v1/x", { input: { b: new Uint8Array([1, 2]) } }, { retry: true });
    expect(r.requestId).toBe("srv-1");
    expect(r.data.out).toEqual(new Uint8Array([3, 4]));
  });
  it("GET sends no body and uses the default request id when the service omits one", async () => {
    const fetchImpl = vi.fn(async (_u: any, init: any) => { expect(init.body).toBeUndefined(); expect(init.headers["content-type"]).toBeUndefined(); return json(200, { ok: 1 }); }) as unknown as typeof fetch;
    const r = await mk(fetchImpl).request("GET", "/health", undefined, { retry: false });
    expect(r.requestId).toMatch(/[0-9a-f-]{36}/);
  });
  it("retries idempotent calls on 5xx/429 with exponential backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    const answers = [json(503, { error: { message: "busy" } }), json(429, {}), json(200, { ok: true })];
    const fetchImpl = vi.fn(async () => answers.shift()!) as unknown as typeof fetch;
    const c = mk(fetchImpl, { retries: 2, backoffMs: 50, sleep: async (ms) => { sleeps.push(ms); } });
    await expect(c.request("POST", "/p", {}, { retry: true })).resolves.toMatchObject({ data: { ok: true } });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([50, 100]);
  });
  it("never retries non-idempotent calls", async () => {
    const fetchImpl = vi.fn(async () => json(500, { error: { message: "boom" } })) as unknown as typeof fetch;
    await expect(mk(fetchImpl).request("POST", "/p", {}, { retry: false })).rejects.toThrow(ServiceUnavailableError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("gives up after the retry budget and reports the last failure", async () => {
    const fetchImpl = vi.fn(async () => json(502, { error: { message: "bad gateway" } })) as unknown as typeof fetch;
    const err = await mk(fetchImpl, { retries: 1 }).request("POST", "/p", {}, { retry: true }).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/bad gateway/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("turns 4xx into a ServiceRejectedError without retry, and does not count it against the breaker", async () => {
    const fetchImpl = vi.fn(async () => json(401, { error: { code: "unauthorized", message: "bad token" } })) as unknown as typeof fetch;
    const c = mk(fetchImpl, { breaker: new CircuitBreaker({ failureThreshold: 1 }) });
    const err = await c.request("POST", "/p", {}, { retry: true }).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceRejectedError);
    expect(err).toMatchObject({ status: 401, code: "unauthorized" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(c.breaker.state).toBe("closed");
  });
  it("handles a non-JSON error body", async () => {
    const fetchImpl = (async () => new Response("<html>", { status: 400, statusText: "Bad Request" })) as unknown as typeof fetch;
    const err = await mk(fetchImpl).request("POST", "/p", {}, { retry: false }).catch((e) => e);
    expect(err).toMatchObject({ status: 400, code: null });
    expect(err.message).toMatch(/Bad Request/);
  });
  it("treats timeouts, network errors and malformed bodies as unavailability", async () => {
    const timeout = (async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as unknown as typeof fetch;
    await expect(mk(timeout).request("POST", "/p", {}, { retry: false, timeoutMs: 5 })).rejects.toThrow(/timed out after 5ms/);
    const refused = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    await expect(mk(refused).request("POST", "/p", {}, { retry: false })).rejects.toThrow(/unreachable: ECONNREFUSED/);
    const weird = (async () => { throw "string failure"; }) as unknown as typeof fetch;
    await expect(mk(weird).request("POST", "/p", {}, { retry: false })).rejects.toThrow(/unreachable: string failure/);
    const bad = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    await expect(mk(bad).request("POST", "/p", {}, { retry: false })).rejects.toThrow(/malformed body/);
  });
  it("actually aborts a hung request at the timeout", async () => {
    const hang = ((_u: any, init: any) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)))) as unknown as typeof fetch;
    await expect(mk(hang, { timeoutMs: 20 }).request("POST", "/p", {}, { retry: false })).rejects.toThrow(/timed out after 20ms/);
  });
  it("opens the breaker after repeated failures and fails fast without calling the service", async () => {
    const fetchImpl = vi.fn(async () => json(500, {})) as unknown as typeof fetch;
    const c = mk(fetchImpl, { breaker: new CircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000 }) });
    await c.request("POST", "/p", {}, { retry: false }).catch(() => {});
    await c.request("POST", "/p", {}, { retry: false }).catch(() => {});
    const err = await c.request("POST", "/p", {}, { retry: true }).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err.message).toMatch(/circuit open/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("uses the global fetch and default timings when none are injected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { ok: 1 })));
    const c = new ServiceClient({ name: "svc", baseUrl: "http://x", audience: "ai-service", issuer: "w", secret: SECRET });
    await expect(c.request("GET", "/h", undefined, { retry: false })).resolves.toMatchObject({ data: { ok: 1 } });
    vi.unstubAllGlobals();
    // default sleep is a real timer: one 100ms backoff
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(503, {})).mockResolvedValueOnce(json(200, { ok: 2 })));
    await expect(c.request("GET", "/h", undefined, { retry: true })).resolves.toMatchObject({ data: { ok: 2 } });
    vi.unstubAllGlobals();
  });
});

/** Same signature bytes, different base64url spelling (flips an unused padding bit of the last character). */
function aliasLastChar(sig: string): string {
  const AB = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  return sig.slice(0, -1) + AB[AB.indexOf(sig.at(-1)!) ^ 1]!;
}
