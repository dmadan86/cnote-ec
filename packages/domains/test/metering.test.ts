import { redis } from "@cnote/core";
import { afterAll, describe, expect, it } from "vitest";
import { classifyHit, dailySalt, keys, normalizePath, recordHit, totalsFromHash, visitorHash } from "../src/metering";

const slug = `mt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DAY = "2099-01-01";
const DAY2 = "2099-01-02";
const HUMAN = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1";
const base = { host: "www.acme.com", path: "/products", storefrontSlug: slug, hostKind: "custom" as const };

afterAll(async () => {
  for (const d of [DAY, DAY2]) await redis.del(keys.hash(d, slug), keys.hll(d, slug), keys.dirty(d), keys.flushing(d), keys.salt(d));
});

describe("classifyHit (pure)", () => {
  it("counts a human page view with source, device and page", () => {
    const c = classifyHit({ ...base, userAgent: HUMAN, referrer: "https://chatgpt.com/", ip: "1.1.1.1" });
    expect(Object.fromEntries(c.fields)).toMatchObject({ req: 1, pv: 1, "page:/products": 1, "dev:mobile": 1, "src:ai_assistant": 1, "ref:chatgpt": 1, "hk:custom": 1 });
    expect(c.countsVisitor).toBe(true);
  });
  it("counts bots as requests + bot hits only", () => {
    const c = classifyHit({ ...base, userAgent: "Mozilla/5.0 (compatible; GPTBot/1.2)" });
    expect(Object.fromEntries(c.fields)).toEqual({ req: 1, "hk:custom": 1, "bot:GPTBot": 1 });
    expect(c.countsVisitor).toBe(false);
  });
  it("counts assets as requests only and skips internal referrers' source", () => {
    expect(Object.fromEntries(classifyHit({ ...base, path: "/_next/static/a.js", userAgent: HUMAN }).fields)).toEqual({ req: 1, "hk:custom": 1 });
    const internal = Object.fromEntries(classifyHit({ ...base, userAgent: HUMAN, referrer: "https://www.acme.com/" }).fields);
    expect(Object.keys(internal).some((k) => k.startsWith("src:"))).toBe(false);
  });
  it("normalises paths", () => {
    expect(normalizePath("/a/b/?x=1#y")).toBe("/a/b");
    expect(normalizePath("")).toBe("/");
  });
});

describe("totalsFromHash", () => {
  it("folds a redis hash", () => {
    const t = totalsFromHash({ req: "10", pv: "6", enq: "1", "src:direct": "4", "ref:google": "2", "page:/": "3", "dev:mobile": "5", "bot:GPTBot": "2", "hk:custom": "10" }, 4);
    expect(t).toMatchObject({ requests: 10, pageviews: 6, enquiries: 1, uniqueVisitors: 4, bySource: { direct: 4 }, byReferrer: { google: 2 }, byPage: { "/": 3 }, byDevice: { mobile: 5 }, botHits: { GPTBot: 2 }, byHostKind: { custom: 10 } });
  });
});

describe("recordHit (redis)", () => {
  it("stores counters, hashes visitors (no raw ip/ua), and de-duplicates uniques", async () => {
    const hit = { ...base, userAgent: HUMAN, ip: "203.0.113.5", referrer: "https://www.google.com/" };
    await recordHit(hit, DAY);
    await recordHit(hit, DAY); // same visitor again
    await recordHit({ ...hit, ip: "203.0.113.6" }, DAY); // another visitor
    await recordHit({ ...base, userAgent: "ClaudeBot/1.0", ip: "10.0.0.1" }, DAY);
    const hash = await redis.hgetall(keys.hash(DAY, slug));
    const t = totalsFromHash(hash, await redis.pfcount(keys.hll(DAY, slug)));
    expect(t.requests).toBe(4);
    expect(t.pageviews).toBe(3);
    expect(t.uniqueVisitors).toBe(2);
    expect(t.bySource).toEqual({ organic_search: 3 });
    expect(t.botHits).toEqual({ ClaudeBot: 1 });
    expect(await redis.sismember(keys.dirty(DAY), slug)).toBe(1);
    // privacy: the only stored visitor material is an HLL (opaque); no key or field contains the ip or ua
    const dump = JSON.stringify(hash) + (await redis.keys(`sfm:*:${DAY}:${slug}`)).join();
    expect(dump).not.toContain("203.0.113");
    expect(dump).not.toContain("iPhone");
  });

  it("uses a different salt per day so visitors are not linkable across days", async () => {
    const s1 = await dailySalt(DAY);
    const s2 = await dailySalt(DAY2);
    expect(s1).not.toBe(s2);
    expect(visitorHash(s1, "1.1.1.1", "ua")).not.toBe(visitorHash(s2, "1.1.1.1", "ua"));
    expect(visitorHash(s1, "1.1.1.1", "ua")).toBe(visitorHash(s1, "1.1.1.1", "ua"));
  });

  it("folds excess distinct pages into (other) so a path-spraying client cannot bloat Redis", async () => {
    const capSlug = `${slug}-cap`;
    try {
      for (let i = 0; i < 3100; i += 100) {
        await Promise.all(Array.from({ length: 100 }, (_, j) => recordHit({ ...base, storefrontSlug: capSlug, path: `/spray/${i + j}`, userAgent: HUMAN, ip: `10.0.${i}.${j}` }, DAY2)));
      }
      const hash = await redis.hgetall(keys.hash(DAY2, capSlug));
      expect(Object.keys(hash).length).toBeLessThan(3100);
      expect(Number(hash["page:(other)"])).toBeGreaterThan(0);
      expect(Number(hash.pv)).toBe(3100); // counted in total regardless
    } finally {
      await redis.del(keys.hash(DAY2, capSlug), keys.hll(DAY2, capSlug), keys.dirty(DAY2));
    }
  });
});
