import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { cachedManyTagged, cachedTagged, getCacheStats, invalidateTags, redis, softInvalidateTags } from "../src/redis";

const uid = () => randomUUID().slice(0, 8);

afterAll(() => redis.quit());

describe("cachedTagged", () => {
  it("serves hits from cache and coalesces concurrent cold loads", async () => {
    const key = `test:cache:${uid()}`;
    let loads = 0;
    const load = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 30));
      return { n: loads };
    };
    const results = await Promise.all(Array.from({ length: 10 }, () => cachedTagged(key, ["t:" + key], 30, load)));
    expect(loads).toBe(1);
    expect(new Set(results.map((r) => r.n))).toEqual(new Set([1]));
    expect(await cachedTagged(key, ["t:" + key], 30, load)).toEqual({ n: 1 });
    expect(loads).toBe(1);
    expect(getCacheStats()["test:cache"]?.hit).toBeGreaterThan(0);
  });

  it("hard invalidation removes entries so the next read reloads (moderation must not serve stale)", async () => {
    const id = uid();
    const key = `test:cache:${id}`;
    let value = "approved";
    const read = () => cachedTagged(key, (v: string) => [`listing:${id}`, v], 60, async () => value, { staleSeconds: 60 });
    expect(await read()).toBe("approved");
    value = "rejected";
    expect(await read()).toBe("approved"); // cached
    await invalidateTags([`listing:${id}`]);
    expect(await read()).toBe("rejected");
  });

  it("soft invalidation serves stale once and refreshes in the background", async () => {
    const tag = `soft:${uid()}`;
    const key = `test:cache:${uid()}`;
    let n = 0;
    const read = () => cachedTagged(key, [tag], 60, async () => ++n, { staleSeconds: 60 });
    expect(await read()).toBe(1);
    await new Promise((r) => setTimeout(r, 5));
    await softInvalidateTags([tag]);
    expect(await read()).toBe(1); // stale served immediately
    await new Promise((r) => setTimeout(r, 150));
    expect(await read()).toBe(2); // background refresh landed
  });

  it("does not resurrect an entry when an invalidation raced with the load", async () => {
    const id = uid();
    const key = `test:cache:${id}`;
    let n = 0;
    const read = () =>
      cachedTagged(key, [`race:${id}`], 60, async () => {
        const mine = ++n;
        await new Promise((r) => setTimeout(r, 50));
        return mine;
      });
    const first = read();
    await new Promise((r) => setTimeout(r, 10));
    await invalidateTags([`race:${id}`]);
    expect(await first).toBe(1);
    expect(await read()).toBe(2); // first result was not cached
  });
});

describe("cachedManyTagged", () => {
  it("loads only the missing ids and never caches absent ones", async () => {
    const p = `test:many:${uid()}`;
    const calls: string[][] = [];
    const load = async (missing: string[]) => {
      calls.push([...missing]);
      return new Map(missing.filter((m) => m !== "ghost").map((m) => [m, m.toUpperCase()]));
    };
    const o = { prefix: p, tags: (id: string) => [`${p}:${id}`], ttlSeconds: 30, load };
    expect((await cachedManyTagged(["a", "b"], o)).get("a")).toBe("A");
    const r = await cachedManyTagged(["a", "b", "c", "ghost"], o);
    expect([...r.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(calls[1]!.sort()).toEqual(["c", "ghost"]);
    await cachedManyTagged(["ghost"], o);
    expect(calls[2]).toEqual(["ghost"]);
    await invalidateTags([`${p}:a`]);
    await cachedManyTagged(["a"], o);
    expect(calls[3]).toEqual(["a"]);
  });
});
