import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachedManyTagged, cachedTagged, cacheTags, cached, getCacheStats, invalidateTags, rateLimit, redis, softInvalidateTags } from "../src/redis";

const uid = () => randomUUID().slice(0, 8);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** Wait until `cond` holds (bounded polling, no fixed sleeps). */
async function until(cond: () => boolean | Promise<boolean>, max = 200) {
  for (let i = 0; i < max; i++) {
    if (await cond()) return;
    await tick(5);
  }
  throw new Error("condition not met");
}
const created: string[] = [];
const k = (p = "test:cm") => {
  const key = `${p}:${uid()}`;
  created.push(key);
  return key;
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  const keys = await redis.keys("test:cm*");
  const more = await redis.keys("ctag*:t-cm-*");
  const locks = await redis.keys("clock:test:cm*");
  const all = [...keys, ...more, ...locks];
  if (all.length) await redis.del(...all);
});

describe("cached (cache-aside)", () => {
  it("loads once, then serves from Redis; values round-trip through JSON", async () => {
    const key = k();
    let n = 0;
    const load = async () => ({ n: ++n, s: "नमस्ते", arr: [1, null] });
    expect(await cached(key, 30, load)).toEqual({ n: 1, s: "नमस्ते", arr: [1, null] });
    expect(await cached(key, 30, load)).toEqual({ n: 1, s: "नमस्ते", arr: [1, null] });
    expect(n).toBe(1);
    expect(await redis.ttl(key)).toBeGreaterThan(0);
  });
  it("does not cache a load failure", async () => {
    const key = k();
    await expect(cached(key, 30, async () => Promise.reject(new Error("db down")))).rejects.toThrow("db down");
    expect(await cached(key, 30, async () => "ok")).toBe("ok");
  });
  it("caches falsy values (0, false, empty string) rather than reloading", async () => {
    let n = 0;
    for (const v of [0, false, ""]) {
      const key = k();
      const load = async () => (n++, v);
      await cached(key, 30, load);
      expect(await cached(key, 30, load)).toBe(v);
    }
    expect(n).toBe(3);
  });
});

describe("rateLimit (fixed window)", () => {
  it("allows exactly `limit` calls per window then blocks", async () => {
    const key = `test:cm:${uid()}`;
    const res: boolean[] = [];
    for (let i = 0; i < 5; i++) res.push(await rateLimit(key, 3, 60));
    expect(res).toEqual([true, true, true, false, false]);
  });
  it("keys are independent", async () => {
    const a = `test:cm:${uid()}`;
    expect(await rateLimit(a, 1, 60)).toBe(true);
    expect(await rateLimit(a, 1, 60)).toBe(false);
    expect(await rateLimit(`test:cm:${uid()}`, 1, 60)).toBe(true);
  });
  it("a new window resets the counter, and the counter key expires with the window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(120_000);
    const key = `test:cm:${uid()}`;
    expect(await rateLimit(key, 1, 60)).toBe(true);
    expect(await rateLimit(key, 1, 60)).toBe(false);
    const rk = `rl:${key}:2`;
    expect(await redis.ttl(rk)).toBeGreaterThan(0);
    expect(await redis.ttl(rk)).toBeLessThanOrEqual(60);
    vi.setSystemTime(180_000);
    expect(await rateLimit(key, 1, 60)).toBe(true);
    await redis.del(rk, `rl:${key}:3`);
  });
  it("concurrent callers never exceed the limit", async () => {
    const key = `test:cm:${uid()}`;
    const res = await Promise.all(Array.from({ length: 30 }, () => rateLimit(key, 10, 60)));
    expect(res.filter(Boolean)).toHaveLength(10);
  });
  it("limit 0 blocks everything", async () => {
    expect(await rateLimit(`test:cm:${uid()}`, 0, 60)).toBe(false);
  });
});

describe("cacheTags", () => {
  it("builds stable, namespaced tag names", () => {
    expect(cacheTags.listing("a")).toBe("listing:a");
    expect(cacheTags.category("x")).toBe("category:x");
    expect(cacheTags.sellerListings("b")).toBe("seller-listings:b");
    expect(cacheTags.seller("b")).toBe("seller:b");
    expect(cacheTags.rating("l")).toBe("rating:l");
    expect(cacheTags.qa("l")).toBe("qa:l");
    expect(cacheTags.reviews("l")).toBe("reviews:l");
    const statics = [cacheTags.categories, cacheTags.sellers, cacheTags.featured, cacheTags.search, cacheTags.reviewsAll, cacheTags.plans, cacheTags.sitemap];
    expect(new Set(statics).size).toBe(statics.length);
  });
});

describe("cachedTagged: behaviours", () => {
  it("stale-while-revalidate: after the fresh window the old value is served instantly and ONE refresh runs", async () => {
    const key = k();
    const tag = `t-cm-${uid()}`;
    let n = 0;
    const load = vi.fn(async () => ++n);
    const read = () => cachedTagged(key, [tag], 1, load, { staleSeconds: 60 });
    expect(await read()).toBe(1);
    // age the entry beyond its fresh window without sleeping: rewrite the envelope
    const env = JSON.parse((await redis.get(key))!);
    await redis.set(key, JSON.stringify({ ...env, f: Date.now() - 1 }), "EX", 60);
    const many = await Promise.all(Array.from({ length: 10 }, () => read()));
    expect(many).toEqual(Array(10).fill(1)); // all served stale
    await until(() => load.mock.calls.length >= 2);
    await tick(20);
    expect(load).toHaveBeenCalledTimes(2); // stampede protection: exactly one refresh
    expect(await read()).toBe(2);
    expect(getCacheStats()["test:cm"]!.stale).toBeGreaterThan(0);
  });

  it("a failing background refresh is swallowed and the stale value keeps being served", async () => {
    const key = k();
    let fail = false;
    const load = async () => {
      if (fail) throw new Error("origin down");
      return "v1";
    };
    await cachedTagged(key, [], 1, load, { staleSeconds: 60 });
    const env = JSON.parse((await redis.get(key))!);
    await redis.set(key, JSON.stringify({ ...env, f: Date.now() - 1 }), "EX", 60);
    fail = true;
    expect(await cachedTagged(key, [], 1, load, { staleSeconds: 60 })).toBe("v1");
    await until(() => (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    expect(await cachedTagged(key, [], 1, load, { staleSeconds: 60 })).toBe("v1");
  });

  it("a cold-load failure propagates and is not cached; the lock is released so the next call retries", async () => {
    const key = k();
    await expect(cachedTagged(key, [], 30, async () => Promise.reject(new Error("nope")))).rejects.toThrow("nope");
    await until(async () => (await redis.exists(`clock:${key}`)) === 0);
    expect(await cachedTagged(key, [], 30, async () => "fine")).toBe("fine");
  });

  it("tags can be derived from the value and invalidating any derived tag purges the entry", async () => {
    const key = k();
    const hit = `t-cm-${uid()}`;
    let n = 0;
    const read = () => cachedTagged(key, (v: { ids: string[] }) => v.ids, 60, async () => (n++, { ids: [hit, `t-cm-${uid()}`] }));
    await read();
    await read();
    expect(n).toBe(1);
    await invalidateTags([hit]);
    await read();
    expect(n).toBe(2);
  });

  it("invalidateTags is a no-op for empty/blank input and dedupes tags; unknown tags are harmless", async () => {
    await expect(invalidateTags([])).resolves.toBeUndefined();
    await expect(invalidateTags(["", ""])).resolves.toBeUndefined();
    const t = `t-cm-${uid()}`;
    await invalidateTags([t, t, `t-cm-${uid()}`]);
    expect(await redis.exists(`ctagv:${t}`)).toBe(1);
    await expect(softInvalidateTags([])).resolves.toBeUndefined();
    await expect(softInvalidateTags([""])).resolves.toBeUndefined();
  });

  it("hard invalidation also clears the tag set, and entries under other tags survive", async () => {
    const a = k(), b = k();
    const ta = `t-cm-${uid()}`, tb = `t-cm-${uid()}`;
    await cachedTagged(a, [ta], 60, async () => "A");
    await cachedTagged(b, [tb], 60, async () => "B");
    expect(await redis.sismember(`ctag:${ta}`, a)).toBe(1);
    await invalidateTags([ta]);
    expect(await redis.exists(a)).toBe(0);
    expect(await redis.exists(`ctag:${ta}`)).toBe(0);
    expect(await redis.exists(b)).toBe(1);
  });

  it("caps the stored TTL at 24h and gives tag sets a 2-day TTL", async () => {
    const key = k();
    const tag = `t-cm-${uid()}`;
    await cachedTagged(key, [tag], 10 * 24 * 3600, async () => 1, { staleSeconds: 10 * 24 * 3600 });
    expect(await redis.ttl(key)).toBeLessThanOrEqual(24 * 3600);
    expect(await redis.ttl(key)).toBeGreaterThan(24 * 3600 - 60);
    expect(await redis.ttl(`ctag:${tag}`)).toBeGreaterThan(2 * 24 * 3600 - 60);
  });

  it("stores undefined/null values without corrupting subsequent reads", async () => {
    const key = k();
    let n = 0;
    const read = () => cachedTagged<null>(key, [], 60, async () => (n++, null));
    expect(await read()).toBeNull();
    expect(await read()).toBeNull();
    expect(n).toBe(1);
  });

  it("fails open when Redis errors on read: serves straight from the source", async () => {
    const key = k();
    vi.spyOn(redis, "pipeline").mockImplementation(() => {
      throw new Error("ECONNRESET");
    });
    let n = 0;
    expect(await cachedTagged(key, ["x"], 60, async () => ++n)).toBe(1);
    expect(await cachedTagged(key, ["x"], 60, async () => ++n)).toBe(2);
    expect(getCacheStats()["test:cm"]!.error).toBeGreaterThan(0);
  });

  it("fails open when the corrupt cached value is not JSON", async () => {
    const key = k();
    await redis.set(key, "{not json", "EX", 60);
    expect(await cachedTagged(key, [], 60, async () => "recovered")).toBe("recovered");
  });

  it("returns the loaded value even when writing the cache fails", async () => {
    const key = k();
    const real = redis.pipeline.bind(redis);
    let calls = 0;
    vi.spyOn(redis, "pipeline").mockImplementation((...a: []) => {
      if (++calls === 1) return real(...a); // the read pipeline
      throw new Error("write failed");
    });
    expect(await cachedTagged(key, ["x"], 60, async () => "v")).toBe("v");
  });

  it("when another instance holds the lock, waits for its result instead of loading", async () => {
    const key = k();
    await redis.set(`clock:${key}`, "1", "EX", 15);
    const load = vi.fn(async () => "mine");
    const p = cachedTagged(key, [], 60, load);
    await tick(20);
    await redis.set(key, JSON.stringify({ v: "theirs", f: Date.now() + 60_000, w: Date.now() }), "EX", 60);
    expect(await p).toBe("theirs");
    expect(load).not.toHaveBeenCalled();
  });

  it("soft invalidation of an unrelated tag does not make an entry stale", async () => {
    const key = k();
    const tag = `t-cm-${uid()}`;
    const load = vi.fn(async () => 1);
    await cachedTagged(key, [tag], 60, load, { staleSeconds: 60 });
    await softInvalidateTags([`t-cm-${uid()}`]);
    await cachedTagged(key, [tag], 60, load, { staleSeconds: 60 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("softTags option lets a value-derived-tag entry be soft-invalidated", async () => {
    const key = k();
    const soft = `t-cm-${uid()}`;
    let n = 0;
    const read = () => cachedTagged(key, () => [], 60, async () => ++n, { staleSeconds: 60, softTags: [soft] });
    expect(await read()).toBe(1);
    await tick(5);
    await softInvalidateTags([soft]);
    expect(await read()).toBe(1);
    await until(() => n === 2);
  });

  it("CACHE_LOG=1 logs each cache decision", async () => {
    const key = k();
    process.env.CACHE_LOG = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await cachedTagged(key, [], 60, async () => 1);
    await cachedTagged(key, [], 60, async () => 1);
    delete process.env.CACHE_LOG;
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[cache\] miss test:cm:/));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[cache\] hit test:cm:/));
  });
});

describe("getCacheStats", () => {
  it("groups by the first two key segments and computes hitRatio", async () => {
    const p = `test:cm-stats${uid()}`;
    const key = `${p}:1`;
    await cachedTagged(key, [], 60, async () => 1); // miss
    await cachedTagged(key, [], 60, async () => 1); // hit
    await cachedTagged(key, [], 60, async () => 1); // hit
    const s = getCacheStats()[p]!;
    expect(s).toMatchObject({ miss: 1, hit: 2, stale: 0, error: 0 });
    expect(s.hitRatio).toBeCloseTo(2 / 3);
    await redis.del(key);
  });
});

describe("cachedManyTagged: behaviours", () => {
  const base = () => {
    const prefix = `test:cm:many:${uid()}`;
    const calls: string[][] = [];
    const load = async (missing: string[]) => (calls.push([...missing]), new Map(missing.map((m) => [m, m.toUpperCase()])));
    return { prefix, calls, o: { prefix, tags: (id: string) => [`t-cm-${prefix}:${id}`], ttlSeconds: 60, staleSeconds: 60, load } };
  };

  it("empty input returns an empty map without touching the loader; duplicates are collapsed", async () => {
    const { o, calls } = base();
    expect((await cachedManyTagged([], o)).size).toBe(0);
    expect(calls).toHaveLength(0);
    const r = await cachedManyTagged(["a", "a", "a"], o);
    expect([...r]).toEqual([["a", "A"]]);
    expect(calls).toEqual([["a"]]);
  });

  it("concurrent identical batches coalesce into one load", async () => {
    const { o, calls } = base();
    await Promise.all(Array.from({ length: 8 }, () => cachedManyTagged(["a", "b"], o)));
    expect(calls).toHaveLength(1);
  });

  it("stale ids are served immediately and refreshed once in the background", async () => {
    const { o, calls, prefix } = base();
    await cachedManyTagged(["a", "b"], o);
    for (const id of ["a"]) {
      const key = `${prefix}:${id}`;
      const env = JSON.parse((await redis.get(key))!);
      await redis.set(key, JSON.stringify({ ...env, v: "OLD", f: Date.now() - 1 }), "EX", 60);
    }
    const r = await cachedManyTagged(["a", "b"], o);
    expect(r.get("a")).toBe("OLD");
    expect(r.get("b")).toBe("B");
    await until(() => calls.length === 2);
    expect(calls[1]).toEqual(["a"]);
    await until(async () => JSON.parse((await redis.get(`${prefix}:a`))!).v === "A");
  });

  it("does not write back ids whose tag was invalidated while loading", async () => {
    const { prefix } = base();
    const tag = `t-cm-${prefix}:a`;
    const o = {
      prefix,
      tags: () => [tag],
      ttlSeconds: 60,
      load: async (m: string[]) => {
        await invalidateTags([tag]);
        return new Map(m.map((x) => [x, "v"]));
      },
    };
    const r = await cachedManyTagged(["a"], o);
    expect(r.get("a")).toBe("v");
    expect(await redis.exists(`${prefix}:a`)).toBe(0);
  });

  it("fails open on a Redis read error", async () => {
    const { o, calls } = base();
    vi.spyOn(redis, "mget").mockRejectedValue(new Error("boom"));
    const r = await cachedManyTagged(["a", "b"], o);
    expect(r.get("b")).toBe("B");
    expect(calls).toEqual([["a", "b"]]);
  });

  it("returns loaded values even if the cache write fails", async () => {
    const { o } = base();
    vi.spyOn(redis, "pipeline").mockImplementation(() => {
      throw new Error("write failed");
    });
    expect((await cachedManyTagged(["a"], o)).get("a")).toBe("A");
  });
});

describe("invalidation racing a fill (check-then-store window)", () => {
  it("an invalidation landing between a fill's freshness check and its write cannot leave a stale entry", async () => {
    const key = k();
    const tag = `t-cm-${uid()}`;
    let source = "old";
    // Simulate another process invalidating right after the fill's pre-write check passed: its member listing finds nothing
    // (the entry is not written yet) and the tag set is gone by the time the fill writes.
    const realMget = redis.mget.bind(redis) as (...a: unknown[]) => Promise<unknown>;
    let injected = false;
    vi.spyOn(redis, "mget").mockImplementation(((...args: unknown[]) => {
      const res = realMget(...args);
      if (injected) return res;
      injected = true;
      return res.then(async (r) => {
        source = "new";
        await invalidateTags([tag]);
        return r;
      });
    }) as never);
    expect(await cachedTagged(key, [tag], 60, async () => source)).toBe("old"); // this caller began before the write: fine
    vi.restoreAllMocks();
    expect(await redis.get(key)).toBeNull(); // ...but the stale value must not stay cached
    expect(await cachedTagged(key, [tag], 60, async () => source)).toBe("new");
  });
});
