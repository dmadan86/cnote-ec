// Scheduled digests (jobs). Both are idempotent: each person/search window is claimed with a compare-and-set on its cursor inside
// the same transaction that emits the event, so a re-run or a concurrent worker can never notify twice.
// Delivery (channel, preferences, consent, unsubscribe) is @cnote/notifications' job; this module only decides WHAT is new.
import { getPublicListingsByIds, listPublicSellerListings } from "@cnote/catalogue";
import { emit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { listSavedListingIds } from "@cnote/wishlist";
import type { SearchFilters } from "@cnote/search";
import { currentMatchIds } from "./saved-searches";
import { MAX_SEEN_IDS } from "./types";

const HOUR_MS = 3_600_000;
const PERIOD_MS = { daily: 24 * HOUR_MS, weekly: 7 * 24 * HOUR_MS } as const;
const SLACK_MS = HOUR_MS; // the job ticks hourly; a digest is due one hour before its nominal period ends
const BATCH = 200;

/** New matches for saved searches that are due. Returns how many digests were emitted. */
export async function runSavedSearchDigests(now = new Date(), limit = BATCH): Promise<number> {
  let sent = 0;
  for (const freq of ["daily", "weekly"] as const) {
    const dueBefore = new Date(now.getTime() - PERIOD_MS[freq] + SLACK_MS);
    const rows = await prisma.savedSearch.findMany({
      where: { frequency: freq, OR: [{ lastRunAt: null }, { lastRunAt: { lte: dueBefore } }] },
      orderBy: { lastRunAt: { sort: "asc", nulls: "first" } },
      take: limit,
    });
    for (const s of rows) {
      let ids: string[];
      try {
        ids = await currentMatchIds(s.query, (s.filters ?? {}) as SearchFilters);
      } catch (e) {
        console.error("[alerts] saved search failed (will retry)", s.id, e);
        continue;
      }
      const seen = new Set(s.seenListingIds as string[]);
      const fresh = ids.filter((id) => !seen.has(id));
      const baseline = s.lastRunAt === null; // first run after a failed baseline: record silently
      const nextSeen = [...new Set([...ids, ...seen])].slice(0, MAX_SEEN_IDS);
      const emitted = await prisma.$transaction(async (tx) => {
        const { count } = await tx.savedSearch.updateMany({ where: { id: s.id, lastRunAt: s.lastRunAt, frequency: freq }, data: { lastRunAt: now, seenListingIds: nextSeen } });
        if (count !== 1 || baseline || !fresh.length) return false;
        await emit(tx, "BuyerAlertTriggered", { type: "SavedSearch", id: s.id }, {
          personId: s.personId, alertType: "saved_search", subjectId: s.id, label: s.name, count: fresh.length, fromPricePaise: null, toPricePaise: null, href: "/account/saved-searches",
        });
        return true;
      });
      if (emitted) sent++;
    }
  }
  return sent;
}

/** The buyer's categories: those of what they saved (wishlist) and of their saved searches. Empty = unknown (no restriction). */
async function buyerCategories(personId: string): Promise<{ ids: Set<string>; slugs: Set<string> }> {
  const ids = new Set<string>();
  const slugs = new Set<string>();
  const saved = await listSavedListingIds(personId, 200);
  if (saved.length) for (const l of await getPublicListingsByIds(saved).catch(() => [])) ids.add(l.category.id), slugs.add(l.category.slug);
  for (const s of await prisma.savedSearch.findMany({ where: { personId }, select: { filters: true } })) {
    for (const slug of ((s.filters as SearchFilters | null)?.categories ?? [])) slugs.add(slug);
  }
  return { ids, slugs };
}

/** Weekly digest of new listings from followed suppliers, within the buyer's categories. Returns how many digests were emitted. */
export async function runFollowedDigests(now = new Date(), limit = BATCH): Promise<number> {
  const dueBefore = new Date(now.getTime() - PERIOD_MS.weekly + SLACK_MS);
  const people = await prisma.alertSettings.findMany({
    where: { followedDigest: true, OR: [{ followedDigestAt: null }, { followedDigestAt: { lte: dueBefore } }] },
    orderBy: { followedDigestAt: { sort: "asc", nulls: "first" } },
    take: limit,
  });
  let sent = 0;
  for (const p of people) {
    const since = p.followedDigestAt ?? new Date(now.getTime() - PERIOD_MS.weekly);
    const follows = await prisma.supplierFollow.findMany({ where: { personId: p.personId }, select: { businessId: true } });
    const cats = follows.length ? await buyerCategories(p.personId) : { ids: new Set<string>(), slugs: new Set<string>() };
    const restrict = cats.ids.size > 0 || cats.slugs.size > 0;
    let count = 0;
    let label = "";
    for (const f of follows) {
      const listings = (await listPublicSellerListings(f.businessId).catch(() => [])).filter(
        (l) => new Date(l.createdAt) > since && (!restrict || cats.ids.has(l.category.id) || cats.slugs.has(l.category.slug)),
      );
      count += listings.length;
      if (!label && listings[0]) label = listings[0].seller?.name ?? "";
    }
    await prisma.$transaction(async (tx) => {
      const { count: claimed } = await tx.alertSettings.updateMany({ where: { personId: p.personId, followedDigestAt: p.followedDigestAt, followedDigest: true }, data: { followedDigestAt: now } });
      if (claimed !== 1 || count === 0) return;
      await emit(tx, "BuyerAlertTriggered", { type: "Person", id: p.personId }, {
        personId: p.personId, alertType: "followed_digest", subjectId: null, label, count, fromPricePaise: null, toPricePaise: null, href: "/buyer/suppliers",
      });
      sent++;
    });
  }
  return sent;
}
