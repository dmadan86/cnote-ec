import { getListingsByIds, type ListingView } from "@cnote/catalogue";
import { DomainError, emit, rateLimit } from "@cnote/core";
import { prisma, Prisma, type Tx } from "@cnote/db";
import { z } from "zod";
import { DEFAULT_LIST_NAME, MAX_ITEMS_PER_LIST, MAX_LISTS_PER_PERSON, MAX_NAME_LENGTH, MAX_NOTE_LENGTH, WRITES_PER_MINUTE } from "./constants";
import type { WishlistDetail, WishlistItemView, WishlistSummary } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nameSchema = z.string().trim().min(1, "Enter a list name").max(MAX_NAME_LENGTH, `Use at most ${MAX_NAME_LENGTH} characters`);
const noteSchema = z.string().trim().max(MAX_NOTE_LENGTH, `Use at most ${MAX_NOTE_LENGTH} characters`).nullable();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new DomainError("validation", r.error.issues[0]?.message ?? "Invalid input");
  return r.data;
}

function requireUuid(id: string, what: string) {
  if (!UUID.test(id)) throw new DomainError("not_found", `${what} not found`);
}

/** Writes are limited to 60/min per person. Fails open if Redis is unavailable. */
async function throttle(personId: string) {
  let ok = true;
  try {
    ok = await rateLimit(`wishlist:${personId}`, WRITES_PER_MINUTE, 60);
  } catch {
    /* fail open */
  }
  if (!ok) throw new DomainError("rate_limited", "You're saving items too quickly. Please wait a minute and try again.");
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/** Serialises writers for one key (e.g. a person's lists) so count limits hold under concurrency. */
async function lock(tx: Tx, key: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

type ListRow = { id: string; name: string; isDefault: boolean; createdAt: Date; updatedAt: Date; _count: { items: number } };
const summaryOf = (r: ListRow): WishlistSummary => ({
  id: r.id,
  name: r.name,
  isDefault: r.isDefault,
  itemCount: r._count.items,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});
const withCount = { _count: { select: { items: true } } } as const;

async function requireOwnedList(personId: string, listId: string, db: Tx | typeof prisma = prisma) {
  requireUuid(listId, "List");
  const row = await db.wishlist.findUnique({ where: { id: listId }, include: withCount });
  if (!row || row.personId !== personId) throw new DomainError("not_found", "List not found", undefined, "wishlist.listNotFound");
  return row;
}

const isVisible = (l: ListingView) => l.status === "published" && l.moderationStatus === "approved";

/** The person's default "Saved items" list, created on first use (safe under concurrent calls). */
export async function getOrCreateDefaultList(personId: string): Promise<WishlistSummary> {
  const find = () => prisma.wishlist.findFirst({ where: { personId, isDefault: true }, include: withCount, orderBy: { createdAt: "asc" } });
  const existing = await find();
  if (existing) return summaryOf(existing);
  try {
    const created = await prisma.wishlist.create({ data: { personId, name: DEFAULT_LIST_NAME, isDefault: true }, include: withCount });
    return summaryOf(created);
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const winner = await find();
    if (!winner) throw e;
    return summaryOf(winner);
  }
}

/** All lists, default first. Does not create the default list. */
export async function listLists(personId: string): Promise<WishlistSummary[]> {
  const rows = await prisma.wishlist.findMany({ where: { personId }, include: withCount, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
  return rows.map(summaryOf);
}

export async function getList(personId: string, listId: string): Promise<WishlistDetail> {
  const list = await requireOwnedList(personId, listId);
  const items = await prisma.wishlistItem.findMany({ where: { wishlistId: listId }, orderBy: { createdAt: "desc" } });
  const listings = new Map((await getListingsByIds(items.map((i) => i.listingId))).map((l) => [l.id, l]));
  const views: WishlistItemView[] = items.map((i) => {
    const listing = listings.get(i.listingId);
    const visible = listing && isVisible(listing) ? listing : null;
    const saved = i.savedPricePaise == null ? null : Number(i.savedPricePaise);
    const current = visible?.pricePaise ?? null;
    return {
      id: i.id,
      listingId: i.listingId,
      note: i.note,
      savedPricePaise: saved,
      currentPricePaise: current,
      priceDropped: saved !== null && current !== null && current < saved,
      createdAt: i.createdAt.toISOString(),
      listing: visible,
    };
  });
  return { ...summaryOf(list), items: views };
}

export async function createList(personId: string, name: string): Promise<WishlistSummary> {
  const clean = parse(nameSchema, name);
  if (clean.toLowerCase() === DEFAULT_LIST_NAME.toLowerCase()) throw new DomainError("conflict", `"${DEFAULT_LIST_NAME}" is reserved for your default list`, undefined, "wishlist.reservedDefaultList", { defaultListName: DEFAULT_LIST_NAME });
  await throttle(personId);
  try {
    return await prisma.$transaction(async (tx) => {
      await lock(tx, `wishlist-lists:${personId}`);
      if ((await tx.wishlist.count({ where: { personId } })) >= MAX_LISTS_PER_PERSON) {
        throw new DomainError("validation", `You can have up to ${MAX_LISTS_PER_PERSON} lists`, undefined, "wishlist.upLists", { maxListsPerPerson: MAX_LISTS_PER_PERSON });
      }
      return summaryOf(await tx.wishlist.create({ data: { personId, name: clean }, include: withCount }));
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new DomainError("conflict", "You already have a list with that name");
    throw e;
  }
}

export async function renameList(personId: string, listId: string, name: string): Promise<WishlistSummary> {
  const clean = parse(nameSchema, name);
  const list = await requireOwnedList(personId, listId);
  if (list.isDefault) throw new DomainError("validation", "Your default list can't be renamed", undefined, "wishlist.defaultListCantRenamed");
  if (clean.toLowerCase() === DEFAULT_LIST_NAME.toLowerCase()) throw new DomainError("conflict", `"${DEFAULT_LIST_NAME}" is reserved for your default list`, undefined, "wishlist.reservedDefaultList", { defaultListName: DEFAULT_LIST_NAME });
  await throttle(personId);
  try {
    return summaryOf(await prisma.wishlist.update({ where: { id: listId }, data: { name: clean }, include: withCount }));
  } catch (e) {
    if (isUniqueViolation(e)) throw new DomainError("conflict", "You already have a list with that name");
    throw e;
  }
}

/** Deletes a non-default list and its items. */
export async function deleteList(personId: string, listId: string): Promise<void> {
  const list = await requireOwnedList(personId, listId);
  if (list.isDefault) throw new DomainError("validation", "Your default list can't be deleted", undefined, "wishlist.defaultListCantDeleted");
  await throttle(personId);
  await prisma.$transaction(async (tx) => {
    const items = await tx.wishlistItem.findMany({ where: { wishlistId: listId }, select: { listingId: true } });
    await tx.wishlist.delete({ where: { id: listId } });
    for (const i of items) await emit(tx, "WishlistItemRemoved", { type: "Wishlist", id: listId }, { wishlistId: listId, personId, listingId: i.listingId });
  });
}

/**
 * Saves a listing to `listId` (default list when omitted). Idempotent: saving twice is a no-op and
 * emits nothing. Only published, approved listings can be saved.
 */
export async function addItem(personId: string, listingId: string, listId?: string): Promise<{ added: boolean; listId: string }> {
  requireUuid(listingId, "Listing");
  const [listing] = await getListingsByIds([listingId]);
  if (!listing || !isVisible(listing)) throw new DomainError("not_found", "This product is no longer available", undefined, "wishlist.productNoLongerAvailable");
  const target = listId ? await requireOwnedList(personId, listId) : await getOrCreateDefaultList(personId);
  await throttle(personId);
  return prisma.$transaction(async (tx) => {
    await lock(tx, `wishlist-items:${target.id}`);
    const existing = await tx.wishlistItem.findUnique({ where: { wishlistId_listingId: { wishlistId: target.id, listingId } } });
    if (existing) return { added: false, listId: target.id };
    if ((await tx.wishlistItem.count({ where: { wishlistId: target.id } })) >= MAX_ITEMS_PER_LIST) {
      throw new DomainError("validation", `A list can hold up to ${MAX_ITEMS_PER_LIST} items`, undefined, "wishlist.listHoldUpItems", { maxItemsPerList: MAX_ITEMS_PER_LIST });
    }
    await tx.wishlistItem.create({
      data: { wishlistId: target.id, listingId, savedPricePaise: listing.pricePaise == null ? null : BigInt(listing.pricePaise) },
    });
    await tx.wishlist.update({ where: { id: target.id }, data: { updatedAt: new Date() } });
    await emit(tx, "WishlistItemAdded", { type: "Wishlist", id: target.id }, { wishlistId: target.id, personId, listingId });
    return { added: true, listId: target.id };
  });
}

/** Removes a listing from one list. Idempotent. */
export async function removeItem(personId: string, listId: string, listingId: string): Promise<{ removed: boolean }> {
  await requireOwnedList(personId, listId);
  await throttle(personId);
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.wishlistItem.deleteMany({ where: { wishlistId: listId, listingId } });
    if (count > 0) await emit(tx, "WishlistItemRemoved", { type: "Wishlist", id: listId }, { wishlistId: listId, personId, listingId });
    return { removed: count > 0 };
  });
}

/** Removes a listing from every list the person has it in (what the card heart does when un-saving). */
export async function removeFromAll(personId: string, listingId: string): Promise<{ removedFrom: number }> {
  if (!UUID.test(listingId)) return { removedFrom: 0 };
  await throttle(personId);
  return prisma.$transaction(async (tx) => {
    const rows = await tx.wishlistItem.findMany({ where: { listingId, wishlist: { personId } }, select: { id: true, wishlistId: true } });
    if (!rows.length) return { removedFrom: 0 };
    await tx.wishlistItem.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    for (const r of rows) await emit(tx, "WishlistItemRemoved", { type: "Wishlist", id: r.wishlistId }, { wishlistId: r.wishlistId, personId, listingId });
    return { removedFrom: rows.length };
  });
}

/**
 * Moves (or copies) a saved listing between the person's lists, keeping its note and price-at-save.
 * Organising lists is not a new demand signal, so no events are emitted.
 */
export async function moveItem(personId: string, input: { fromListId: string; toListId: string; listingId: string; copy?: boolean }): Promise<void> {
  const { fromListId, toListId, listingId, copy } = input;
  await Promise.all([requireOwnedList(personId, fromListId), requireOwnedList(personId, toListId)]);
  if (fromListId === toListId) return;
  await throttle(personId);
  await prisma.$transaction(async (tx) => {
    await lock(tx, `wishlist-items:${toListId}`);
    const src = await tx.wishlistItem.findUnique({ where: { wishlistId_listingId: { wishlistId: fromListId, listingId } } });
    if (!src) throw new DomainError("not_found", "Item not found in that list", undefined, "wishlist.itemNotFoundList");
    const dup = await tx.wishlistItem.findUnique({ where: { wishlistId_listingId: { wishlistId: toListId, listingId } } });
    if (!dup) {
      if ((await tx.wishlistItem.count({ where: { wishlistId: toListId } })) >= MAX_ITEMS_PER_LIST) {
        throw new DomainError("validation", `A list can hold up to ${MAX_ITEMS_PER_LIST} items`, undefined, "wishlist.listHoldUpItems", { maxItemsPerList: MAX_ITEMS_PER_LIST });
      }
      await tx.wishlistItem.create({
        data: { wishlistId: toListId, listingId, note: src.note, savedPricePaise: src.savedPricePaise, createdAt: src.createdAt },
      });
      await tx.wishlist.update({ where: { id: toListId }, data: { updatedAt: new Date() } });
    }
    if (!copy) await tx.wishlistItem.delete({ where: { id: src.id } });
  });
}

/** Sets or clears (null/empty) the buyer's private note on a saved item. */
export async function updateNote(personId: string, listId: string, listingId: string, note: string | null): Promise<void> {
  const clean = parse(noteSchema, note === "" ? null : note);
  await requireOwnedList(personId, listId);
  await throttle(personId);
  const { count } = await prisma.wishlistItem.updateMany({ where: { wishlistId: listId, listingId }, data: { note: clean || null } });
  if (count === 0) throw new DomainError("not_found", "Item not found in that list", undefined, "wishlist.itemNotFoundList");
}

/** Which of `listingIds` the person has saved in any list (for product cards). */
export async function isSaved(personId: string, listingIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(listingIds.filter((i) => UUID.test(i)))];
  if (!ids.length) return new Set();
  const rows = await prisma.wishlistItem.findMany({ where: { listingId: { in: ids }, wishlist: { personId } }, select: { listingId: true }, distinct: ["listingId"] });
  return new Set(rows.map((r) => r.listingId));
}

/** Every listing id the person has saved (cards use this to render hearts in one query). Capped. */
export async function listSavedListingIds(personId: string, limit = 5000): Promise<string[]> {
  const rows = await prisma.wishlistItem.findMany({ where: { wishlist: { personId } }, select: { listingId: true }, distinct: ["listingId"], take: limit });
  return rows.map((r) => r.listingId);
}

/** Number of distinct listings the person has saved (header badge). */
export async function countSaved(personId: string): Promise<number> {
  const rows = await prisma.wishlistItem.findMany({ where: { wishlist: { personId } }, select: { listingId: true }, distinct: ["listingId"] });
  return rows.length;
}

/** How many lists across all buyers hold each listing (demand signal; no person data). */
export async function savedCountFor(listingIds: string[]): Promise<Map<string, number>> {
  const ids = [...new Set(listingIds.filter((i) => UUID.test(i)))];
  const out = new Map<string, number>();
  if (!ids.length) return out;
  const rows = await prisma.wishlistItem.groupBy({ by: ["listingId"], where: { listingId: { in: ids } }, _count: { _all: true } });
  for (const r of rows) out.set(r.listingId, r._count._all);
  return out;
}

/**
 * People who currently have `listingId` saved, with the price they saw when they saved it (for price-drop alerts). Distinct per
 * person; capped. Feeds an event handler only, never a seller-facing view (buyers stay anonymous).
 */
export async function listSaversOfListing(listingId: string, limit = 5000): Promise<{ personId: string; savedPricePaise: number | null }[]> {
  if (!UUID.test(listingId)) return [];
  const rows = await prisma.wishlistItem.findMany({
    where: { listingId },
    select: { savedPricePaise: true, wishlist: { select: { personId: true } } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  const out = new Map<string, number | null>();
  for (const r of rows) {
    const p = r.wishlist.personId;
    const price = r.savedPricePaise === null ? null : Number(r.savedPricePaise);
    const prev = out.get(p);
    // a person with the listing in several lists: keep the highest price they saw
    if (!out.has(p) || (price !== null && (prev === null || (prev !== undefined && price > prev)))) out.set(p, price);
  }
  return [...out].map(([personId, savedPricePaise]) => ({ personId, savedPricePaise }));
}

/** Erasure (ADR-010): deletes all of the person's lists and items. Idempotent. */
export async function erasePersonWishlists(personId: string): Promise<void> {
  await prisma.wishlist.deleteMany({ where: { personId } });
}
