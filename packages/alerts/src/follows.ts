// Followed suppliers. A follow is a private bookmark plus an optional weekly digest; it NEVER affects ranking (ADR-000/009) and the
// supplier only ever sees an aggregate count.
import { listPublicSellerListings } from "@cnote/catalogue";
import { DomainError, emit, rateLimit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { getTrustProfiles } from "@cnote/identity";
import { MAX_FOLLOWS_PER_PERSON, WRITES_PER_MINUTE, type FollowedSupplierView } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LISTINGS_PER_SUPPLIER = 3;

export async function throttle(personId: string, scope: string) {
  let ok = true;
  try {
    ok = await rateLimit(`alerts:${scope}:${personId}`, WRITES_PER_MINUTE, 60);
  } catch {
    /* fail open when Redis is unavailable */
  }
  if (!ok) throw new DomainError("rate_limited", "You're doing that too quickly. Please wait a minute and try again.", undefined, "alerts.rateLimited");
}

/** Follow a supplier. Idempotent: following twice is a no-op and emits nothing. */
export async function followSupplier(personId: string, businessId: string): Promise<{ following: true; created: boolean }> {
  if (!UUID.test(businessId)) throw new DomainError("not_found", "Supplier not found", undefined, "alerts.supplierNotFound");
  if (!(await getTrustProfiles([businessId])).has(businessId)) throw new DomainError("not_found", "Supplier not found", undefined, "alerts.supplierNotFound");
  await throttle(personId, "follow");
  const created = await prisma.$transaction(async (tx) => {
    if (await tx.supplierFollow.findUnique({ where: { personId_businessId: { personId, businessId } }, select: { id: true } })) return false;
    if ((await tx.supplierFollow.count({ where: { personId } })) >= MAX_FOLLOWS_PER_PERSON) {
      throw new DomainError("validation", `You can follow up to ${MAX_FOLLOWS_PER_PERSON} suppliers`, undefined, "alerts.upFollows", { max: MAX_FOLLOWS_PER_PERSON });
    }
    const { count } = await tx.supplierFollow.createMany({ data: [{ personId, businessId }], skipDuplicates: true });
    if (count === 1) await emit(tx, "SupplierFollowChanged", { type: "Business", id: businessId }, { personId, businessId, following: true });
    return count === 1;
  });
  return { following: true, created };
}

/** Unfollow. Idempotent. */
export async function unfollowSupplier(personId: string, businessId: string): Promise<{ following: false; removed: boolean }> {
  if (!UUID.test(businessId)) return { following: false, removed: false };
  await throttle(personId, "follow");
  const removed = await prisma.$transaction(async (tx) => {
    const { count } = await tx.supplierFollow.deleteMany({ where: { personId, businessId } });
    if (count > 0) await emit(tx, "SupplierFollowChanged", { type: "Business", id: businessId }, { personId, businessId, following: false });
    return count > 0;
  });
  return { following: false, removed };
}

export async function isFollowing(personId: string, businessId: string): Promise<boolean> {
  if (!UUID.test(businessId)) return false;
  return !!(await prisma.supplierFollow.findUnique({ where: { personId_businessId: { personId, businessId } }, select: { id: true } }));
}

/** The person's followed suppliers (newest follow first) with each supplier's newest live listings. */
export async function listFollowedSuppliers(personId: string): Promise<FollowedSupplierView[]> {
  const rows = await prisma.supplierFollow.findMany({ where: { personId }, orderBy: { createdAt: "desc" }, take: MAX_FOLLOWS_PER_PERSON });
  if (!rows.length) return [];
  const profiles = await getTrustProfiles(rows.map((r) => r.businessId));
  const out: FollowedSupplierView[] = [];
  for (const r of rows) {
    const p = profiles.get(r.businessId);
    if (!p) continue; // business gone
    const listings = await listPublicSellerListings(r.businessId).catch(() => []);
    out.push({
      businessId: r.businessId,
      name: p.name,
      city: p.city,
      state: p.state,
      verificationTier: p.verificationTier,
      badgeActive: p.badgeActive,
      followedAt: r.createdAt.toISOString(),
      // LIVE views carry the first-publication time in createdAt; listPublicSellerListings is already newest-first
      latestListings: listings.slice(0, LISTINGS_PER_SUPPLIER).map((l) => ({ id: l.id, title: l.title, pricePaise: l.pricePaise, priceUnit: l.priceUnit, publishedAt: l.createdAt })),
    });
  }
  return out;
}

/** Aggregate only: how many buyers follow this supplier. No identities, ever (seller dashboard). */
export async function countFollowers(businessId: string): Promise<number> {
  if (!UUID.test(businessId)) return 0;
  return prisma.supplierFollow.count({ where: { businessId } });
}
