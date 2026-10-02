// Read-only public share links for a wishlist (buyer convenience).
// The link carries an unguessable token (256 random bits). The public view exposes ONLY the list name and the public
// listing facts: never the owner, the private notes, the saved prices or any contact data (DPDP data minimisation).
// Revoking deletes the row, so the link stops working at once.
import { getPublicListingsByIds, type ListingView } from "@cnote/catalogue";
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { randomBytes } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** base64url of 32 random bytes is 43 chars. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface WishlistShareView {
  token: string;
  createdAt: string;
}

export interface SharedWishlistView {
  name: string;
  /** Only published, approved listings; archived or unpublished ones silently drop out. */
  listings: ListingView[];
}

async function requireOwned(personId: string, listId: string) {
  if (!UUID.test(listId)) throw new DomainError("not_found", "List not found", undefined, "wishlist.listNotFound");
  const row = await prisma.wishlist.findUnique({ where: { id: listId }, select: { id: true, personId: true } });
  if (!row || row.personId !== personId) throw new DomainError("not_found", "List not found", undefined, "wishlist.listNotFound");
}

/** The list's live share link, or null when it is not shared. */
export async function getShare(personId: string, listId: string): Promise<WishlistShareView | null> {
  await requireOwned(personId, listId);
  const s = await prisma.wishlistShare.findUnique({ where: { wishlistId: listId } });
  return s ? { token: s.token, createdAt: s.createdAt.toISOString() } : null;
}

/** Starts sharing a list (idempotent: returns the existing link when there is one). */
export async function createShare(personId: string, listId: string): Promise<WishlistShareView> {
  await requireOwned(personId, listId);
  const existing = await prisma.wishlistShare.findUnique({ where: { wishlistId: listId } });
  if (existing) return { token: existing.token, createdAt: existing.createdAt.toISOString() };
  try {
    const s = await prisma.wishlistShare.create({ data: { wishlistId: listId, token: randomBytes(32).toString("base64url") } });
    return { token: s.token, createdAt: s.createdAt.toISOString() };
  } catch (e) {
    // Lost a race with a concurrent create: return the winner.
    const winner = await prisma.wishlistShare.findUnique({ where: { wishlistId: listId } });
    if (winner) return { token: winner.token, createdAt: winner.createdAt.toISOString() };
    throw e;
  }
}

/** Stops sharing: the old link dies immediately. A later createShare issues a NEW token. Idempotent. */
export async function revokeShare(personId: string, listId: string): Promise<{ revoked: boolean }> {
  await requireOwned(personId, listId);
  const { count } = await prisma.wishlistShare.deleteMany({ where: { wishlistId: listId } });
  return { revoked: count > 0 };
}

/** What an anonymous visitor with the link sees. Null for an unknown, malformed or revoked token. */
export async function getSharedWishlist(token: string): Promise<SharedWishlistView | null> {
  if (!TOKEN_RE.test(token)) return null;
  const s = await prisma.wishlistShare.findUnique({
    where: { token },
    select: { wishlist: { select: { name: true, items: { orderBy: { createdAt: "desc" }, take: 200, select: { listingId: true } } } } },
  });
  if (!s) return null;
  const listings = await getPublicListingsByIds(s.wishlist.items.map((i) => i.listingId));
  const byId = new Map(listings.map((l) => [l.id, l]));
  return { name: s.wishlist.name, listings: s.wishlist.items.map((i) => byId.get(i.listingId)).filter((l): l is ListingView => !!l) };
}
