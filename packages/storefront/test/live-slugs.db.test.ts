import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { getLiveStorefrontSlugs } from "../src";

const tag = Math.random().toString(36).slice(2, 8);
const made: { biz: string; sfId: string }[] = [];

async function storefront(status: "draft" | "live" | "suspended", published: boolean) {
  const biz = randomUUID();
  const sf = await prisma.storefront.create({ data: { sellerBusinessId: biz, slug: `ls-${tag}-${made.length}`, status } });
  if (published) {
    const v = await prisma.storefrontVersion.create({ data: { storefrontId: sf.id, version: 1, document: {}, status: "published" } });
    await prisma.storefront.update({ where: { id: sf.id }, data: { publishedVersionId: v.id } });
  }
  made.push({ biz, sfId: sf.id });
  return { biz, slug: sf.slug };
}

afterAll(async () => {
  const ids = made.map((m) => m.sfId);
  await prisma.storefront.updateMany({ where: { id: { in: ids } }, data: { publishedVersionId: null } });
  await prisma.storefrontVersion.deleteMany({ where: { storefrontId: { in: ids } } });
  await prisma.storefront.deleteMany({ where: { id: { in: ids } } });
});

describe("getLiveStorefrontSlugs", () => {
  it("returns slugs only for live, published, non-suspended storefronts", async () => {
    const live = await storefront("live", true);
    const draft = await storefront("draft", false);
    const suspended = await storefront("suspended", true);
    const liveNoVersion = await storefront("live", false);
    const none = randomUUID();
    const out = await getLiveStorefrontSlugs([live.biz, draft.biz, suspended.biz, liveNoVersion.biz, none]);
    expect([...out]).toEqual([[live.biz, live.slug]]);
  });
  it("returns an empty map for no ids", async () => {
    expect((await getLiveStorefrontSlugs([])).size).toBe(0);
  });
});
