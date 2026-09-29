import { redis } from "@cnote/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PTR_TTL, VERSION_TTL, bust, layoutPtrKey, layoutVersionKey, softCached, tplPtrKey, tplVersionKey } from "../src/cache";

afterEach(() => vi.restoreAllMocks());

describe("cache keys", () => {
  it("are namespaced and distinct per dimension", () => {
    const keys = [tplPtrKey("a.b", "email", "en"), tplPtrKey("a.b", "sms", "en"), tplPtrKey("a.b", "email", "hi"), layoutPtrKey("default"), tplVersionKey("id"), layoutVersionKey("id")];
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => k.startsWith("tpl:"))).toBe(true);
    expect(tplPtrKey("a.b", "email", "en")).toBe("tpl:ptr:a.b:email:en");
  });
  it("published versions are immutable so they cache far longer than the mutable pointers", () => {
    expect(VERSION_TTL).toBeGreaterThan(PTR_TTL);
    expect(PTR_TTL).toBeLessThanOrEqual(300);
  });
});

describe("softCached", () => {
  const key = () => `tpl:test:${crypto.randomUUID()}`;
  it("caches loader results (including null) and serves them without reloading", async () => {
    const k = key();
    const load = vi.fn(async () => ({ v: 1 }));
    expect(await softCached(k, 30, load)).toEqual({ v: 1 });
    expect(await softCached(k, 30, load)).toEqual({ v: 1 });
    expect(load).toHaveBeenCalledTimes(1);
    const k2 = key();
    const nullLoad = vi.fn(async () => null);
    await softCached(k2, 30, nullLoad);
    await softCached(k2, 30, nullLoad);
    expect(nullLoad).toHaveBeenCalledTimes(1);
    await redis.del(k, k2);
  });
  it("degrades to the loader when Redis is unavailable (connection-type errors only)", async () => {
    for (const msg of ["Connection is closed", "ECONNREFUSED 127.0.0.1:6379", "Stream isn't writeable and enableOfflineQueue options is false", "Reached the max retries per request limit", "redis down"]) {
      vi.spyOn(redis, "get").mockRejectedValueOnce(new Error(msg));
      const load = vi.fn(async () => "from-db");
      expect(await softCached(key(), 30, load), msg).toBe("from-db");
      expect(load).toHaveBeenCalledTimes(1);
    }
  });
  it("does not swallow loader errors (a DB failure must surface, not be retried silently)", async () => {
    await expect(softCached(key(), 30, async () => Promise.reject(new Error("relation does not exist")))).rejects.toThrow("relation does not exist");
    await expect(softCached(key(), 30, async () => Promise.reject(new TypeError("bad")))).rejects.toThrow("bad");
  });
  it("a non-Error rejection propagates unchanged", async () => {
    vi.spyOn(redis, "get").mockRejectedValueOnce("string failure");
    await expect(softCached(key(), 30, async () => 1)).rejects.toBe("string failure");
  });
});

describe("bust", () => {
  it("deletes the given keys, ignores an empty list, and never throws when Redis fails", async () => {
    const a = `tpl:test:${crypto.randomUUID()}`;
    const b = `tpl:test:${crypto.randomUUID()}`;
    await redis.set(a, "1", "EX", 30);
    await redis.set(b, "1", "EX", 30);
    await bust(a, b);
    expect(await redis.exists(a, b)).toBe(0);
    const del = vi.spyOn(redis, "del");
    await bust();
    expect(del).not.toHaveBeenCalled();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    del.mockRejectedValueOnce(new Error("down"));
    await expect(bust("x")).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
  });
});
