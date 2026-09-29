import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const listings = new Map<string, { id: string; pricePaise: number | null }>();
vi.mock("@cnote/catalogue", () => ({
  getListingsByIds: async (ids: string[]) =>
    ids.flatMap((id) => {
      const l = listings.get(id);
      return l ? [{ ...l, status: "published", moderationStatus: "approved", title: "T" }] : [];
    }),
}));

import {
  addItem, createList, deleteList, erasePersonWishlists, getList, getOrCreateDefaultList, isSaved, listLists, moveItem, removeFromAll,
  removeItem, updateNote, MAX_ITEMS_PER_LIST, MAX_LISTS_PER_PERSON, worker,
} from "../src";

const people: string[] = [];
let p: string;
const listing = (price: number | null = 10000) => {
  const id = randomUUID();
  listings.set(id, { id, pricePaise: price });
  return id;
};
beforeEach(() => {
  p = randomUUID();
  people.push(p);
});
afterAll(async () => {
  const lists = await prisma.wishlist.findMany({ where: { personId: { in: people } }, select: { id: true } });
  await prisma.domainEvent.deleteMany({ where: { aggregateType: "Wishlist", aggregateId: { in: lists.map((l) => l.id) } } });
  await prisma.wishlist.deleteMany({ where: { personId: { in: people } } });
});

describe("wishlist (DB)", () => {
  it("creates the default list once under concurrency", async () => {
    const res = await Promise.all(Array.from({ length: 6 }, () => getOrCreateDefaultList(p)));
    expect(new Set(res.map((r) => r.id)).size).toBe(1);
    expect(await prisma.wishlist.count({ where: { personId: p } })).toBe(1);
    expect(res[0]!.name).toBe("Saved items");
  });

  it("add is idempotent, snapshots price and emits once", async () => {
    const l = listing(5000);
    const a = await addItem(p, l);
    const b = await addItem(p, l);
    expect([a.added, b.added]).toEqual([true, false]);
    const ev = await prisma.domainEvent.count({ where: { type: "WishlistItemAdded", aggregateId: a.listId } });
    expect(ev).toBe(1);
    const detail = await getList(p, a.listId);
    expect(detail.items[0]!.savedPricePaise).toBe(5000);
    expect((await isSaved(p, [l, randomUUID()])).has(l)).toBe(true);
  });

  it("rejects unknown listings", async () => {
    await expect(addItem(p, randomUUID())).rejects.toMatchObject({ code: "not_found" });
  });

  it("flags price drops", async () => {
    const l = listing(5000);
    const { listId } = await addItem(p, l);
    listings.get(l)!.pricePaise = 4000;
    expect((await getList(p, listId)).items[0]!.priceDropped).toBe(true);
  });

  it("enforces the list limit and unique names", async () => {
    await getOrCreateDefaultList(p);
    for (let i = 1; i < MAX_LISTS_PER_PERSON; i++) await createList(p, `List ${i}`);
    await expect(createList(p, "One too many")).rejects.toMatchObject({ code: "validation" });
    expect(await listLists(p)).toHaveLength(MAX_LISTS_PER_PERSON);
    await expect(createList(p, "List 1")).rejects.toMatchObject({ code: "validation" }); // limit hit first
  });

  it("rejects duplicate and reserved names", async () => {
    await createList(p, "Diwali");
    await expect(createList(p, "Diwali")).rejects.toMatchObject({ code: "conflict" });
    await expect(createList(p, "saved items")).rejects.toMatchObject({ code: "conflict" });
  });

  it("enforces the item limit", async () => {
    const list = await createList(p, "Big");
    const rows = Array.from({ length: MAX_ITEMS_PER_LIST }, () => ({ wishlistId: list.id, listingId: randomUUID() }));
    await prisma.wishlistItem.createMany({ data: rows });
    await expect(addItem(p, listing(), list.id)).rejects.toMatchObject({ code: "validation" });
  });

  it("moves and copies between lists keeping the note", async () => {
    const l = listing();
    const from = await addItem(p, l);
    const to = await createList(p, "Project A");
    await updateNote(p, from.listId, l, "ask for sample");
    await moveItem(p, { fromListId: from.listId, toListId: to.id, listingId: l, copy: true });
    expect((await getList(p, from.listId)).items).toHaveLength(1);
    expect((await getList(p, to.id)).items[0]!.note).toBe("ask for sample");
    await moveItem(p, { fromListId: from.listId, toListId: to.id, listingId: l });
    expect((await getList(p, from.listId)).items).toHaveLength(0);
    expect((await getList(p, to.id)).items).toHaveLength(1);
  });

  it("cannot touch another person's list", async () => {
    const other = randomUUID();
    people.push(other);
    const theirs = await getOrCreateDefaultList(other);
    await expect(getList(p, theirs.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(addItem(p, listing(), theirs.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("forbids deleting the default list; deletes others with events", async () => {
    const def = await getOrCreateDefaultList(p);
    await expect(deleteList(p, def.id)).rejects.toMatchObject({ code: "validation" });
    const l = listing();
    const custom = await createList(p, "Temp");
    await addItem(p, l, custom.id);
    await deleteList(p, custom.id);
    expect(await prisma.domainEvent.count({ where: { type: "WishlistItemRemoved", aggregateId: custom.id } })).toBe(1);
    expect(await prisma.wishlist.count({ where: { id: custom.id } })).toBe(0);
  });

  it("removes from one list and from all", async () => {
    const l = listing();
    const a = await addItem(p, l);
    const b = await createList(p, "B");
    await addItem(p, l, b.id);
    expect((await removeItem(p, a.listId, l)).removed).toBe(true);
    expect((await removeItem(p, a.listId, l)).removed).toBe(false);
    expect((await removeFromAll(p, l)).removedFrom).toBe(1);
    expect((await isSaved(p, [l])).size).toBe(0);
  });

  it("erasure handler deletes everything and is idempotent", async () => {
    await addItem(p, listing());
    await createList(p, "X");
    await worker.handlers.DataErasureRequested!({ id: 1, type: "DataErasureRequested", version: 1, aggregateType: "Person", aggregateId: p, payload: { personId: p }, occurredAt: new Date().toISOString() });
    expect(await prisma.wishlist.count({ where: { personId: p } })).toBe(0);
    await expect(erasePersonWishlists(p)).resolves.toBeUndefined();
  });
});
