import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it, vi } from "vitest";

const listings = new Map<string, { id: string; title: string }>();
vi.mock("@cnote/catalogue", () => ({
  getListingsByIds: async (ids: string[]) => ids.flatMap((id) => (listings.has(id) ? [{ ...listings.get(id)!, pricePaise: 100, status: "published", moderationStatus: "approved" }] : [])),
  // Only "public" (published + approved) listings come back, like the real function.
  getPublicListingsByIds: async (ids: string[]) => ids.flatMap((id) => (listings.has(id) ? [{ ...listings.get(id)!, pricePaise: 100 }] : [])),
}));

import { addItem, createList, createShare, deleteList, erasePersonWishlists, getOrCreateDefaultList, getShare, getSharedWishlist, revokeShare, updateNote } from "../src";

const people: string[] = [];
const person = () => {
  const p = randomUUID();
  people.push(p);
  return p;
};
const listing = (title = "Kraft box") => {
  const id = randomUUID();
  listings.set(id, { id, title });
  return id;
};
afterAll(async () => {
  const lists = await prisma.wishlist.findMany({ where: { personId: { in: people } }, select: { id: true } });
  await prisma.domainEvent.deleteMany({ where: { aggregateType: "Wishlist", aggregateId: { in: lists.map((l) => l.id) } } });
  await prisma.wishlist.deleteMany({ where: { personId: { in: people } } });
});

describe("wishlist share links (DB)", () => {
  it("creates an unguessable token, idempotently, and serves a PII-free read-only view", async () => {
    const p = person();
    const l = listing();
    const { listId } = await addItem(p, l);
    await updateNote(p, listId, l, "my private note about pricing");
    const a = await createShare(p, listId);
    const b = await createShare(p, listId);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b.token).toBe(a.token);
    expect((await getShare(p, listId))?.token).toBe(a.token);

    const view = await getSharedWishlist(a.token);
    expect(view?.name).toBe("Saved items");
    expect(view?.listings.map((x) => x.id)).toEqual([l]);
    // No owner, note or saved price anywhere in the public payload.
    const json = JSON.stringify(view);
    expect(json).not.toContain(p);
    expect(json).not.toContain("private note");
    expect(json).not.toContain("savedPrice");
  });

  it("concurrent creates converge on one token", async () => {
    const p = person();
    const list = await getOrCreateDefaultList(p);
    const res = await Promise.all(Array.from({ length: 5 }, () => createShare(p, list.id)));
    expect(new Set(res.map((r) => r.token)).size).toBe(1);
    expect(await prisma.wishlistShare.count({ where: { wishlistId: list.id } })).toBe(1);
  });

  // The two branches below are what the racy test above only sometimes reaches (depends on scheduling), so they are
  // pinned deterministically: the "does a share exist?" read is forced to miss while the row really exists.
  it("losing a create race returns the winner's link (deterministic)", async () => {
    const p = person();
    const list = await getOrCreateDefaultList(p);
    const winner = await createShare(p, list.id);
    const spy = vi.spyOn(prisma.wishlistShare, "findUnique").mockResolvedValueOnce(null);
    try {
      const res = await createShare(p, list.id);
      expect(res.token).toBe(winner.token);
    } finally {
      spy.mockRestore();
    }
  });

  it("a failed create with no winner to return rethrows the original error (deterministic)", async () => {
    const p = person();
    const list = await getOrCreateDefaultList(p);
    await createShare(p, list.id);
    const spy = vi.spyOn(prisma.wishlistShare, "findUnique").mockResolvedValue(null);
    try {
      await expect(createShare(p, list.id)).rejects.toMatchObject({ code: "P2002" });
    } finally {
      spy.mockRestore();
    }
  });

  it("revoking kills the link at once and a new share issues a new token", async () => {
    const p = person();
    const list = await getOrCreateDefaultList(p);
    const first = await createShare(p, list.id);
    expect(await revokeShare(p, list.id)).toEqual({ revoked: true });
    expect(await revokeShare(p, list.id)).toEqual({ revoked: false });
    expect(await getSharedWishlist(first.token)).toBeNull();
    expect(await getShare(p, list.id)).toBeNull();
    const second = await createShare(p, list.id);
    expect(second.token).not.toBe(first.token);
    expect(await getSharedWishlist(first.token)).toBeNull();
    expect(await getSharedWishlist(second.token)).not.toBeNull();
  });

  it("only the owner can share or revoke; malformed tokens are not found", async () => {
    const owner = person();
    const other = person();
    const list = await getOrCreateDefaultList(owner);
    await expect(createShare(other, list.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(revokeShare(other, list.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(getShare(owner, "not-a-uuid")).rejects.toMatchObject({ code: "not_found" });
    expect(await getSharedWishlist("short")).toBeNull();
    expect(await getSharedWishlist("a".repeat(43))).toBeNull();
  });

  it("deleting the list or erasing the person removes the link", async () => {
    const p = person();
    const named = await createList(p, "Packaging project");
    const t1 = await createShare(p, named.id);
    await deleteList(p, named.id);
    expect(await getSharedWishlist(t1.token)).toBeNull();

    const d = await getOrCreateDefaultList(p);
    const t2 = await createShare(p, d.id);
    await erasePersonWishlists(p);
    expect(await getSharedWishlist(t2.token)).toBeNull();
    expect(await prisma.wishlistShare.count({ where: { token: t2.token } })).toBe(0);
  });
});
