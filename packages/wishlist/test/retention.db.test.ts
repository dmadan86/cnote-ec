import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { purgeStaleEmptyWishlists } from "../src";

const ago = (d: number) => new Date(Date.now() - d * 86_400_000);
const personId = randomUUID();
const mk = (name: string, o: { days: number; isDefault?: boolean; item?: boolean }) =>
  prisma.wishlist.create({
    data: { personId, name, isDefault: o.isDefault ?? false, updatedAt: ago(o.days), ...(o.item ? { items: { create: { listingId: randomUUID() } } } : {}) },
  }).then((w) => w.id);
afterAll(async () => {
  await prisma.wishlist.deleteMany({ where: { personId } });
});

describe("purgeStaleEmptyWishlists", () => {
  it("deletes only stale, empty, non-default lists", async () => {
    const [gone, def, withItem, fresh] = [await mk("a", { days: 900 }), await mk("b", { days: 900, isDefault: true }), await mk("c", { days: 900, item: true }), await mk("d", { days: 1 })];
    const cutoff = ago(800);
    expect(await purgeStaleEmptyWishlists(cutoff, { dryRun: true })).toBeGreaterThanOrEqual(1);
    expect(await prisma.wishlist.count({ where: { id: gone } })).toBe(1);
    expect(await purgeStaleEmptyWishlists(cutoff)).toBeGreaterThanOrEqual(1);
    expect(await prisma.wishlist.count({ where: { id: gone } })).toBe(0);
    expect(await prisma.wishlist.count({ where: { id: { in: [def, withItem, fresh] } } })).toBe(3);
    await purgeStaleEmptyWishlists(cutoff);
  });
});
