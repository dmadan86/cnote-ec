import { afterEach, describe, expect, it } from "vitest";
import { HttpRegistry, getRegistry, isEntryActive, parseLookupResponse, setFetch, setRegistry } from "../src/registry";

const entry = { subscriber_id: "bap.x", ukId: "k1", signing_public_key: "PUB", status: "SUBSCRIBED", valid_from: "2020-01-01T00:00:00Z", valid_until: "2099-01-01T00:00:00Z", type: "BAP", subscriber_url: "https://bap.x" };
afterEach(() => { setFetch(undefined); setRegistry(undefined); });

describe("registry", () => {
  it("parses lookup responses defensively", () => {
    expect(parseLookupResponse("nope")).toEqual([]);
    expect(parseLookupResponse([null, 3, { subscriber_id: "a" }, entry, { ...entry, ukId: undefined, unique_key_id: "k2", valid_from: "bad", type: 1, subscriber_url: 1, status: 1 }])).toHaveLength(2);
    expect(parseLookupResponse([entry])[0]).toMatchObject({ subscriberId: "bap.x", uniqueKeyId: "k1", signingPublicKey: "PUB", type: "BAP" });
  });
  it("only accepts SUBSCRIBED entries inside their validity window", () => {
    const [e] = parseLookupResponse([entry]);
    expect(isEntryActive(e!)).toBe(true);
    expect(isEntryActive({ ...e!, status: "INITIATED" })).toBe(false);
    expect(isEntryActive({ ...e!, validFrom: new Date(Date.now() + 1e6) })).toBe(false);
    expect(isEntryActive({ ...e!, validUntil: new Date(Date.now() - 1e6) })).toBe(false);
    expect(isEntryActive({ ...e!, validFrom: null, validUntil: null })).toBe(true);
  });
  it("looks up over HTTP and caches positives and negatives", async () => {
    let calls = 0; let body: unknown = [entry]; let t = Date.now();
    setFetch(async (url, init) => { calls++; expect(url).toBe("https://reg.example/lookup"); expect(JSON.parse(init.body!)).toMatchObject({ subscriber_id: "bap.x", ukId: "k1", country: "IND" }); return { ok: true, status: 200, text: async () => JSON.stringify(body) }; });
    const r = new HttpRegistry({ registryUrl: "https://reg.example", now: () => t, positiveTtlMs: 1000, negativeTtlMs: 100 });
    expect((await r.lookup({ subscriberId: "bap.x", uniqueKeyId: "k1" }))?.signingPublicKey).toBe("PUB");
    await r.lookup({ subscriberId: "bap.x", uniqueKeyId: "k1" });
    expect(calls).toBe(1);
    t += 1001; body = [];
    expect(await r.lookup({ subscriberId: "bap.x", uniqueKeyId: "k1" })).toBeNull();
    await r.lookup({ subscriberId: "bap.x", uniqueKeyId: "k1" });
    expect(calls).toBe(2);
    t += 101; await r.lookup({ subscriberId: "bap.x", uniqueKeyId: "k1" });
    expect(calls).toBe(3);
  });
  it("does not cache transient failures", async () => {
    let calls = 0;
    setFetch(async () => { calls++; return { ok: false, status: 502, text: async () => "" }; });
    const r = new HttpRegistry({ registryUrl: "https://reg.example" });
    await expect(r.lookup({ subscriberId: "a", uniqueKeyId: "b" })).rejects.toThrow(/502/);
    await expect(r.lookup({ subscriberId: "a", uniqueKeyId: "b" })).rejects.toThrow();
    expect(calls).toBe(2);
  });
  it("uses the configured registry by default and can be swapped", async () => {
    expect(getRegistry()).toBeInstanceOf(HttpRegistry);
    const mock = { lookup: async () => null };
    setRegistry(mock);
    expect(getRegistry()).toBe(mock);
  });
});
