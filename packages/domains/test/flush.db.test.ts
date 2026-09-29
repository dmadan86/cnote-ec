import { redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dayKey, flushTraffic, keys, recordHit } from "../src/metering";
import { getTrafficSummary } from "../src/queries";

const uniq = `flush-test-${Date.now()}`;
let bizId: string;
let sfId: string;
const slug = `ft-${Date.now().toString(36)}`;
const HUMAN = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537.36";

beforeAll(async () => {
  bizId = (await prisma.business.create({ data: { name: uniq } })).id;
  sfId = (await prisma.storefront.create({ data: { sellerBusinessId: bizId, slug } })).id;
});
afterAll(async () => {
  const day = dayKey();
  await redis.del(keys.hash(day, slug), keys.hll(day, slug), keys.dirty(day), keys.flushing(day));
  await prisma.storefrontTrafficDaily.deleteMany({ where: { storefrontId: sfId } });
  await prisma.storefront.delete({ where: { id: sfId } });
  await prisma.business.delete({ where: { id: bizId } });
});

describe("flushTraffic", () => {
  it("upserts absolute totals and is idempotent", async () => {
    const hit = { host: `${slug}.localhost`, path: "/", storefrontSlug: slug, hostKind: "subdomain" as const, userAgent: HUMAN, ip: "198.51.100.1", referrer: "https://www.bing.com/" };
    await recordHit(hit);
    await recordHit({ ...hit, ip: "198.51.100.2", path: "/about" });
    await recordHit({ ...hit, userAgent: "Googlebot/2.1" });
    const first = await flushTraffic();
    expect(first.flushed).toBeGreaterThanOrEqual(1);
    const row = () => prisma.storefrontTrafficDaily.findMany({ where: { storefrontId: sfId } });
    let rows = await row();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requests: 3, pageviews: 2, uniqueVisitors: 2 });
    expect(rows[0]!.bySource).toEqual({ organic_search: 2 });
    expect(rows[0]!.botHits).toEqual({ Googlebot: 1 });

    // replaying the flush (no new hits, then a forced re-mark) must not change totals
    await redis.sadd(keys.dirty(dayKey()), slug);
    await flushTraffic();
    await redis.sadd(keys.dirty(dayKey()), slug);
    await flushTraffic();
    rows = await row();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requests: 3, pageviews: 2, uniqueVisitors: 2 });

    // new traffic converges to the new absolute total
    await recordHit({ ...hit, ip: "198.51.100.3" });
    await flushTraffic();
    expect((await row())[0]).toMatchObject({ requests: 4, pageviews: 3, uniqueVisitors: 3 });

    const summary = await getTrafficSummary(sfId);
    expect(summary.totals).toMatchObject({ requests: 4, pageviews: 3, uniqueVisitors: 3, botHits: 1 });
    expect(summary.bySource[0]).toEqual({ key: "organic_search", count: 3 });
  });
});
