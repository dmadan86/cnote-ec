import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

type L = { id: string; pricePaise: number | null; status: string; moderationStatus: string };
const state = vi.hoisted(() => ({ listings: new Map<string, unknown>(), rate: "ok" as "ok" | "deny" | "throw" }));
vi.mock("@cnote/catalogue", () => ({
  getListingsByIds: async (ids: string[]) => ids.flatMap((id) => (state.listings.has(id) ? [state.listings.get(id)] : [])),
}));
vi.mock("@cnote/core", async (orig) => ({
  ...(await orig<typeof import("@cnote/core")>()),
  rateLimit: async () => {
    if (state.rate === "throw") throw new Error("redis down");
    return state.rate === "ok";
  },
}));

import {
  addItem, countSaved, createList, deleteList, getList, getOrCreateDefaultList, isSaved, listLists, listSavedListingIds, moveItem, removeFromAll, removeItem,
  renameList, savedCountFor, updateNote,
} from "../src";

const people: string[] = [];
let p: string;
const put = (over: Partial<L> = {}) => {
  const l: L = { id: randomUUID(), pricePaise: 10000, status: "published", moderationStatus: "approved", ...over };
  state.listings.set(l.id, l);
  return l;
};
beforeEach(() => {
  p = randomUUID();
  people.push(p);
  state.rate = "ok";
});
afterAll(async () => {
  const lists = await prisma.wishlist.findMany({ where: { personId: { in: people } }, select: { id: true } });
  await prisma.domainEvent.deleteMany({ where: { aggregateType: "Wishlist", aggregateId: { in: lists.map((l) => l.id) } } });
  await prisma.wishlist.deleteMany({ where: { personId: { in: people } } });
});

describe("saving", () => {
  it("only published+approved listings; malformed ids are not_found", async () => {
    await expect(addItem(p, "not-a-uuid")).rejects.toMatchObject({ code: "not_found" });
    for (const over of [{ status: "draft" }, { status: "archived" }, { moderationStatus: "pending" }, { moderationStatus: "rejected" }]) {
      await expect(addItem(p, put(over).id)).rejects.toMatchObject({ code: "not_found" });
    }
    expect(await prisma.wishlist.count({ where: { personId: p } })).toBe(0);
  });

  it("concurrent saves of the same item add once and emit once", async () => {
    const l = put();
    const res = await Promise.all(Array.from({ length: 6 }, () => addItem(p, l.id)));
    expect(res.filter((r) => r.added)).toHaveLength(1);
    expect(new Set(res.map((r) => r.listId)).size).toBe(1);
    expect(await prisma.wishlistItem.count({ where: { listingId: l.id, wishlist: { personId: p } } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { type: "WishlistItemAdded", aggregateId: res[0]!.listId } })).toBe(1);
  });

  it("the item cap holds under concurrency", async () => {
    const list = await createList(p, "Cap");
    await prisma.wishlistItem.createMany({ data: Array.from({ length: 499 }, () => ({ wishlistId: list.id, listingId: randomUUID() })) });
    const res = await Promise.allSettled(Array.from({ length: 4 }, () => addItem(p, put().id, list.id)));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.wishlistItem.count({ where: { wishlistId: list.id } })).toBe(500);
  });

  it("the list cap holds under concurrency", async () => {
    await getOrCreateDefaultList(p);
    for (let i = 1; i < 18; i++) await createList(p, `L${i}`);
    const res = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => createList(p, `Race${i}`)));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(await prisma.wishlist.count({ where: { personId: p } })).toBe(20);
  });

  it("price snapshot is null for unpriced listings and no drop is ever flagged", async () => {
    const l = put({ pricePaise: null });
    const { listId } = await addItem(p, l.id);
    const item = (await getList(p, listId)).items[0]!;
    expect(item).toMatchObject({ savedPricePaise: null, currentPricePaise: null, priceDropped: false });
  });
});

describe("price-drop computation", () => {
  it.each([
    [5000, 4000, true],
    [5000, 5000, false],
    [5000, 6000, false],
    [5000, null, false],
  ])("saved %s, now %s -> dropped %s", async (saved, now, dropped) => {
    const l = put({ pricePaise: saved });
    const { listId } = await addItem(p, l.id);
    (state.listings.get(l.id) as L).pricePaise = now;
    expect((await getList(p, listId)).items[0]!.priceDropped).toBe(dropped);
  });

  it("an item whose listing was unpublished or vanished shows listing=null and never a drop", async () => {
    const a = put();
    const b = put();
    const { listId } = await addItem(p, a.id);
    await addItem(p, b.id, listId);
    (state.listings.get(a.id) as L).status = "archived";
    (state.listings.get(a.id) as L).pricePaise = 1;
    state.listings.delete(b.id);
    const items = (await getList(p, listId)).items;
    expect(items).toHaveLength(2);
    for (const i of items) expect(i).toMatchObject({ listing: null, currentPricePaise: null, priceDropped: false });
  });
});

describe("lists", () => {
  it("rename: default protected, reserved + duplicate names conflict, validation shapes, ownership", async () => {
    const def = await getOrCreateDefaultList(p);
    await expect(renameList(p, def.id, "Mine")).rejects.toMatchObject({ code: "validation" });
    const a = await createList(p, "A");
    await createList(p, "B");
    expect((await renameList(p, a.id, "  Renamed  ")).name).toBe("Renamed");
    await expect(renameList(p, a.id, "b")).resolves.toBeTruthy(); // case-different is allowed by DB (unique is exact)
    await expect(renameList(p, a.id, "Saved Items")).rejects.toMatchObject({ code: "conflict" });
    await expect(renameList(p, a.id, "   ")).rejects.toMatchObject({ code: "validation" });
    await expect(renameList(p, a.id, "x".repeat(81))).rejects.toMatchObject({ code: "validation" });
    await expect(createList(p, "")).rejects.toMatchObject({ code: "validation" });
    await expect(renameList(p, a.id, "B")).rejects.toMatchObject({ code: "conflict" });
    await expect(renameList(randomUUID(), a.id, "Z")).rejects.toMatchObject({ code: "not_found" });
    await expect(renameList(p, "bad-id", "Z")).rejects.toMatchObject({ code: "not_found" });
  });

  it("listLists puts default first; getOrCreateDefaultList is stable; listLists doesn't create", async () => {
    expect(await listLists(p)).toEqual([]);
    await createList(p, "Zed");
    const def = await getOrCreateDefaultList(p);
    const ls = await listLists(p);
    expect(ls[0]!.id).toBe(def.id);
    expect(ls[0]!.isDefault).toBe(true);
    expect((await getOrCreateDefaultList(p)).id).toBe(def.id);
  });

  it("deleteList requires ownership", async () => {
    const other = randomUUID();
    people.push(other);
    const theirs = await createList(other, "Theirs");
    await expect(deleteList(p, theirs.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await prisma.wishlist.count({ where: { id: theirs.id } })).toBe(1);
  });
});

describe("move / copy / notes", () => {
  it("move preserves note, saved price and createdAt; no events; dup target is not duplicated", async () => {
    const l = put({ pricePaise: 700 });
    const from = await addItem(p, l.id);
    const to = await createList(p, "To");
    await updateNote(p, from.listId, l.id, "  keep me  ");
    const before = await prisma.wishlistItem.findFirstOrThrow({ where: { wishlistId: from.listId } });
    const evBefore = await prisma.domainEvent.count({ where: { aggregateId: { in: [from.listId, to.id] } } });
    await moveItem(p, { fromListId: from.listId, toListId: to.id, listingId: l.id });
    const moved = await prisma.wishlistItem.findFirstOrThrow({ where: { wishlistId: to.id } });
    expect(moved).toMatchObject({ note: "keep me", savedPricePaise: 700n });
    expect(moved.createdAt).toEqual(before.createdAt);
    expect(await prisma.domainEvent.count({ where: { aggregateId: { in: [from.listId, to.id] } } })).toBe(evBefore);
    // target already has it: moving just removes the source
    await addItem(p, l.id, from.listId);
    await moveItem(p, { fromListId: from.listId, toListId: to.id, listingId: l.id });
    expect(await prisma.wishlistItem.count({ where: { listingId: l.id, wishlist: { personId: p } } })).toBe(1);
  });

  it("errors: same list is a no-op, missing item, foreign list, target full", async () => {
    const l = put();
    const a = await addItem(p, l.id);
    const b = await createList(p, "B");
    await moveItem(p, { fromListId: a.listId, toListId: a.listId, listingId: l.id });
    expect(await prisma.wishlistItem.count({ where: { wishlistId: a.listId } })).toBe(1);
    await expect(moveItem(p, { fromListId: a.listId, toListId: b.id, listingId: randomUUID() })).rejects.toMatchObject({ code: "not_found" });
    const other = randomUUID();
    people.push(other);
    const theirs = await createList(other, "T");
    await expect(moveItem(p, { fromListId: a.listId, toListId: theirs.id, listingId: l.id })).rejects.toMatchObject({ code: "not_found" });
    await prisma.wishlistItem.createMany({ data: Array.from({ length: 500 }, () => ({ wishlistId: b.id, listingId: randomUUID() })) });
    await expect(moveItem(p, { fromListId: a.listId, toListId: b.id, listingId: l.id })).rejects.toMatchObject({ code: "validation" });
    expect(await prisma.wishlistItem.count({ where: { wishlistId: a.listId } })).toBe(1); // source untouched
  });

  it("notes: trimmed, cleared with null/empty, max 500, missing item -> not_found", async () => {
    const l = put();
    const { listId } = await addItem(p, l.id);
    await updateNote(p, listId, l.id, "  hello ");
    expect((await getList(p, listId)).items[0]!.note).toBe("hello");
    await updateNote(p, listId, l.id, "");
    expect((await getList(p, listId)).items[0]!.note).toBeNull();
    await updateNote(p, listId, l.id, "x");
    await updateNote(p, listId, l.id, null);
    expect((await getList(p, listId)).items[0]!.note).toBeNull();
    await expect(updateNote(p, listId, l.id, "x".repeat(501))).rejects.toMatchObject({ code: "validation" });
    await updateNote(p, listId, l.id, "y".repeat(500));
    await expect(updateNote(p, listId, randomUUID(), "n")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("saved lookups and demand counts", () => {
  it("isSaved / listSavedListingIds / countSaved dedupe across lists; savedCountFor counts lists across people", async () => {
    const l1 = put();
    const l2 = put();
    const a = await addItem(p, l1.id);
    const b = await createList(p, "B");
    await addItem(p, l1.id, b.id);
    await addItem(p, l2.id, b.id);
    const other = randomUUID();
    people.push(other);
    await addItem(other, l1.id);
    expect(await countSaved(p)).toBe(2);
    expect(new Set(await listSavedListingIds(p))).toEqual(new Set([l1.id, l2.id]));
    expect(await listSavedListingIds(p, 1)).toHaveLength(1);
    expect(await isSaved(p, ["junk", l1.id, l1.id, randomUUID()])).toEqual(new Set([l1.id]));
    expect((await isSaved(p, ["junk"])).size).toBe(0);
    const counts = await savedCountFor([l1.id, l2.id, "junk", l1.id]);
    expect(counts.get(l1.id)).toBe(3);
    expect(counts.get(l2.id)).toBe(1);
    expect((await savedCountFor([])).size).toBe(0);
    expect(await countSaved(randomUUID())).toBe(0);
    expect(a.listId).toBeTruthy();
  });

  it("removeFromAll emits per list and ignores malformed ids; removeItem on a foreign list is not_found", async () => {
    const l = put();
    const a = await addItem(p, l.id);
    const b = await createList(p, "B");
    await addItem(p, l.id, b.id);
    expect(await removeFromAll(p, "nope")).toEqual({ removedFrom: 0 });
    expect(await removeFromAll(p, randomUUID())).toEqual({ removedFrom: 0 });
    expect(await removeFromAll(p, l.id)).toEqual({ removedFrom: 2 });
    expect(await prisma.domainEvent.count({ where: { type: "WishlistItemRemoved", aggregateId: { in: [a.listId, b.id] } } })).toBe(2);
    await expect(removeItem(randomUUID(), a.listId, l.id)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("rate limiting", () => {
  it("denies writes with rate_limited and changes nothing; fails open when redis is down", async () => {
    const l = put();
    await getOrCreateDefaultList(p);
    state.rate = "deny";
    await expect(addItem(p, l.id)).rejects.toMatchObject({ code: "rate_limited" });
    await expect(createList(p, "X")).rejects.toMatchObject({ code: "rate_limited" });
    await expect(removeFromAll(p, l.id)).rejects.toMatchObject({ code: "rate_limited" });
    expect(await countSaved(p)).toBe(0);
    state.rate = "throw";
    expect((await addItem(p, l.id)).added).toBe(true);
  });
});
