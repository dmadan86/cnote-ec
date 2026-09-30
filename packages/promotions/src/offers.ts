// Seller offers (ADR-025 (2), design 6.2): volume tiers, limited-time price, free delivery over a MOQ.
//
// Honesty guarantees enforced here in code (CCPA dark-pattern guidelines 2023; E-Commerce Amendment Rules 2026 r.4(9)):
//  1. The strike-through "reference price" is computed by the platform from ListingPriceHistory (lowest price in the preceding
//     30 days). No input of this module accepts a seller-typed "original price".
//  2. Under 30 days of history => no reference => price only, no "was" price, no percentage.
//  3. Percentages are rounded DOWN and shown only when the reference is above the offer price.
//  4. At read time the shown reference is min(reference at activation, reference now): it can never exceed the true 30-day low.
//  5. Offers really end: the expiry job ends them, and the public read never serves an offer past its endsAt.
//  6. Timed offers: max 30 days, 14-day cooldown (no permanent sale), 3% minimum, deep/below-floor discounts held for staff review.
//  7. Offers never influence organic rank (this module exports nothing to search ranking).
import { referencePrice } from "@cnote/catalogue";
import { cachedTagged, cacheTags, DomainError, emit } from "@cnote/core";
import { prisma, type Tx } from "@cnote/db";
import { getTrustProfiles } from "@cnote/identity";
import { z } from "zod";
import { addDays, DAY_MS, OFFER, offerFloorPaise, promotionsEnabled } from "./config";
import { getListingFacts, type ListingFacts } from "./ports";
import { bustOffers, promoTags } from "./tags";

export type OfferKindName = "volume_tiers" | "timed_price" | "free_delivery_moq";
export type OfferStatusName = "draft" | "needs_review" | "active" | "rejected" | "expired" | "cancelled" | "suspended";
export type ReviewFlag = "deep_discount" | "below_floor" | "prior_honour_complaint";

const money = z.number().int().positive().max(1_000_000_000_000);
const qty = z.number().int().positive().max(1_000_000_000);
const tierSchema = z.object({ minQty: qty, unitPricePaise: money });
const region = z.string().trim().min(2).max(60);

export const offerInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("volume_tiers"),
    listingId: z.uuid(),
    terms: z.object({ tiers: z.array(tierSchema).min(1).max(OFFER.maxTiers) }),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().nullish(),
  }),
  z.object({
    kind: z.literal("timed_price"),
    listingId: z.uuid(),
    terms: z.object({ unitPricePaise: money }),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date(),
  }),
  z.object({
    kind: z.literal("free_delivery_moq"),
    listingId: z.uuid(),
    terms: z
      .object({ minQty: qty.optional(), minOrderValuePaise: money.optional(), regions: z.array(region).max(40).optional() })
      .refine((t) => t.minQty !== undefined || t.minOrderValuePaise !== undefined, { message: "Set a minimum quantity or a minimum order value" }),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().nullish(),
  }),
]);
export type OfferInput = z.input<typeof offerInputSchema>;

export interface OfferView {
  id: string;
  listingId: string;
  sellerBusinessId: string;
  kind: OfferKindName;
  status: OfferStatusName;
  terms: unknown;
  startsAt: string;
  endsAt: string | null;
  referencePricePaise: number | null;
  discountBps: number | null;
  reviewFlags: string[];
  reviewNote: string | null;
  endedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

type OfferRow = NonNullable<Awaited<ReturnType<typeof prisma.listingOffer.findUnique>>>;
const toView = (o: OfferRow): OfferView => ({
  id: o.id,
  listingId: o.listingId,
  sellerBusinessId: o.sellerBusinessId,
  kind: o.kind,
  status: o.status,
  terms: o.terms,
  startsAt: o.startsAt.toISOString(),
  endsAt: o.endsAt?.toISOString() ?? null,
  referencePricePaise: o.referencePricePaise === null ? null : Number(o.referencePricePaise),
  discountBps: o.discountBps,
  reviewFlags: o.reviewFlags,
  reviewNote: o.reviewNote,
  endedReason: o.endedReason,
  createdAt: o.createdAt.toISOString(),
  updatedAt: o.updatedAt.toISOString(),
});

// ---------------------------------------------------------------------------------------------- pure rules

/** Discount in basis points, rounded DOWN; null unless the reference is strictly above the price. */
export function discountBpsFrom(referencePaise: number | null, pricePaise: number): number | null {
  if (referencePaise === null || referencePaise <= pricePaise) return null;
  return Math.floor(((referencePaise - pricePaise) * 10_000) / referencePaise);
}
/** Whole percent shown to buyers, rounded down (never rounded up). */
export const percentOff = (bps: number | null): number | null => (bps === null ? null : Math.floor(bps / 100));

export interface AssessCtx {
  basePricePaise: number | null;
  moq: number | null;
  /** platform-derived lowest 30-day price, or null when history is under 30 days */
  referencePaise: number | null;
  floorPaise: number;
  startsAt: Date;
  endsAt: Date | null;
}
export interface Assessment {
  errors: string[];
  flags: ReviewFlag[];
  /** discount vs the honest reference (best tier for volume offers); null when there is no reference or no discount */
  discountBps: number | null;
}

const inr = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** Validates terms against the LIVE listing. Pure: no I/O, so the whole matrix is unit-testable. */
export function assessOffer(input: z.output<typeof offerInputSchema>, ctx: AssessCtx): Assessment {
  const errors: string[] = [];
  const flags: ReviewFlag[] = [];
  const { basePricePaise: base, moq, referencePaise: ref } = ctx;
  let discountBps: number | null = null;
  const compareTo = ref ?? base;

  if (input.kind === "volume_tiers") {
    const tiers = input.terms.tiers;
    if (base === null) errors.push("This listing has no price yet. Add a price before creating a volume offer.");
    if (moq !== null && tiers[0]!.minQty < moq) errors.push(`The first tier must start at or above the minimum order quantity (${moq}).`);
    tiers.forEach((t, i) => {
      if (i > 0 && t.minQty <= tiers[i - 1]!.minQty) errors.push("Tier quantities must strictly increase.");
      if (i > 0 && t.unitPricePaise >= tiers[i - 1]!.unitPricePaise) errors.push("Tier prices must strictly decrease as quantity grows.");
      if (base !== null && t.unitPricePaise >= base) errors.push(`Every tier price must be below the listing price (${inr(base)}).`);
    });
    const best = Math.min(...tiers.map((t) => t.unitPricePaise));
    if (compareTo !== null && best < compareTo && ((compareTo - best) * 10_000) / compareTo > OFFER.maxDiscountBps) flags.push("deep_discount");
    if (tiers.some((t) => t.unitPricePaise < ctx.floorPaise)) flags.push("below_floor");
    discountBps = discountBpsFrom(ref, best);
  } else if (input.kind === "timed_price") {
    const price = input.terms.unitPricePaise;
    if (base === null) errors.push("This listing has no price yet. Add a price before creating a timed offer.");
    else if (price >= base) errors.push(`The offer price must be below the current listing price (${inr(base)}).`);
    if (compareTo !== null && price < compareTo) {
      const bps = ((compareTo - price) * 10_000) / compareTo;
      if (bps < OFFER.minDiscountBps) errors.push(ref === null ? "The offer must be at least 3% below the listing price." : "The offer must be at least 3% below the lowest price of the last 30 days.");
      if (bps > OFFER.maxDiscountBps) flags.push("deep_discount");
    } else if (compareTo !== null && base !== null && price < base) {
      errors.push("The offer must be at least 3% below the lowest price of the last 30 days.");
    }
    if (price < ctx.floorPaise) flags.push("below_floor");
    if (!ctx.endsAt) errors.push("A timed offer needs an end date.");
    else {
      const ms = ctx.endsAt.getTime() - ctx.startsAt.getTime();
      if (ms < 3_600_000) errors.push("A timed offer must run for at least one hour.");
      if (ms > OFFER.maxTimedDays * DAY_MS) errors.push(`A timed offer can run for at most ${OFFER.maxTimedDays} days. Start a new one after the cooldown.`);
    }
    discountBps = discountBpsFrom(ref, price);
  } else {
    const t = input.terms;
    if (t.minQty !== undefined && moq !== null && t.minQty < moq) errors.push(`The minimum quantity must be at or above the listing's minimum order quantity (${moq}).`);
  }

  if (ctx.endsAt && input.kind !== "timed_price" && ctx.endsAt <= ctx.startsAt) errors.push("The end date must be after the start date.");
  return { errors: [...new Set(errors)], flags: [...new Set(flags)], discountBps };
}

function parseInput(input: OfferInput) {
  const r = offerInputSchema.safeParse(input);
  if (!r.success) throw new DomainError("validation", r.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "), r.error.issues);
  return r.data;
}

// ---------------------------------------------------------------------------------------------- honour history

/** Upheld honour reports against a seller in the window: input to the review flag and to offer privilege suspension. */
export async function upheldReportCount(sellerBusinessId: string, now = new Date()): Promise<number> {
  return prisma.offerHonourReport.count({ where: { upheld: true, decidedAt: { gte: addDays(now, -OFFER.upheldWindowDays) }, offer: { sellerBusinessId } } });
}
export async function offerPrivilegesSuspended(sellerBusinessId: string, now = new Date()): Promise<boolean> {
  return (await upheldReportCount(sellerBusinessId, now)) >= OFFER.suspendAfterUpheld;
}

// ---------------------------------------------------------------------------------------------- lifecycle

async function activateTx(tx: Tx, o: OfferRow, referencePaise: number | null, now: Date): Promise<OfferRow> {
  const terms = o.terms as { unitPricePaise?: number; tiers?: { unitPricePaise: number }[] };
  const best = o.kind === "timed_price" ? terms.unitPricePaise : o.kind === "volume_tiers" ? Math.min(...(terms.tiers ?? []).map((t) => t.unitPricePaise)) : undefined;
  const bps = best === undefined ? null : discountBpsFrom(referencePaise, best);
  const row = await tx.listingOffer.update({
    where: { id: o.id },
    data: { status: "active", referencePricePaise: referencePaise === null ? null : BigInt(referencePaise), referenceComputedAt: now, discountBps: bps },
  });
  await emit(tx, "OfferActivated", { type: "offer", id: o.id }, {
    offerId: o.id, listingId: o.listingId, sellerBusinessId: o.sellerBusinessId, referencePricePaise: referencePaise, discountBps: bps, startsAt: o.startsAt.toISOString(), endsAt: o.endsAt?.toISOString() ?? null,
  });
  return row;
}

const facts = async (listingId: string): Promise<ListingFacts | null> => {
  const f = await getListingFacts(listingId);
  return f && f.published ? f : null;
};

/**
 * Seller creates an offer. Clean offers are auto-approved (active now, or scheduled); flagged ones wait for `offers.review`.
 * Eligibility: the seller owns the listing, the listing is live, seller tier >= 1, and offer privileges are not suspended.
 */
export async function createOffer(sellerBusinessId: string, input: OfferInput, now = new Date()): Promise<OfferView> {
  if (!promotionsEnabled()) throw new DomainError("forbidden", "Offers are temporarily unavailable.");
  const d = parseInput(input);
  const listing = await facts(d.listingId);
  if (!listing) throw new DomainError("not_found", "Listing not found or not live");
  if (listing.sellerBusinessId !== sellerBusinessId) throw new DomainError("forbidden", "You can only create offers on your own listings");
  const tier = (await getTrustProfiles([sellerBusinessId])).get(sellerBusinessId)?.verificationTier ?? 0;
  if (tier < 1) throw new DomainError("forbidden", "Verify your business (GSTIN) to run offers.");
  const upheld = await upheldReportCount(sellerBusinessId, now);
  if (upheld >= OFFER.suspendAfterUpheld) throw new DomainError("forbidden", "Offers are paused on your account after buyer reports that were upheld. Contact support to review.");

  const startsAt = d.startsAt ?? now;
  if (startsAt.getTime() < now.getTime() - 5 * 60_000) throw new DomainError("validation", "The start time is in the past.");
  if (startsAt.getTime() > now.getTime() + OFFER.maxLeadDays * DAY_MS) throw new DomainError("validation", `Offers can be scheduled at most ${OFFER.maxLeadDays} days ahead.`);
  const endsAt = d.endsAt ?? null;

  const ref = await referencePrice(listing.id, now);
  const a = assessOffer(d, { basePricePaise: listing.pricePaise, moq: listing.moq, referencePaise: ref, floorPaise: offerFloorPaise(listing.categorySlug), startsAt, endsAt });
  if (a.errors.length) throw new DomainError("validation", a.errors[0]!, { errors: a.errors });
  const flags: ReviewFlag[] = [...a.flags, ...(upheld > 0 ? (["prior_honour_complaint"] as const) : [])];
  const needsReview = flags.length > 0;
  const start = startsAt <= now;

  const created = await prisma.$transaction(async (tx) => {
    // serialise concurrent creates for the same (listing, kind) so the conflict/cooldown checks below cannot race
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`offer:${listing.id}:${d.kind}`}))`;
    const open = await tx.listingOffer.findFirst({ where: { listingId: listing.id, kind: d.kind, status: { in: ["draft", "needs_review", "active"] } } });
    if (open) throw new DomainError("conflict", "This listing already has an offer of this kind in progress. Cancel it first.");
    if (d.kind === "timed_price") {
      const prior = await tx.listingOffer.findMany({
        where: { listingId: listing.id, kind: "timed_price", referenceComputedAt: { not: null }, status: { in: ["expired", "cancelled", "suspended", "active"] } },
        orderBy: { updatedAt: "desc" },
        take: 5,
      });
      for (const p of prior) {
        const endedAt = p.status === "expired" ? (p.endsAt ?? p.updatedAt) : p.endsAt && p.endsAt < p.updatedAt ? p.endsAt : p.updatedAt;
        const free = addDays(endedAt, OFFER.cooldownDays);
        if (startsAt < free) throw new DomainError("conflict", `Timed offers need a ${OFFER.cooldownDays}-day gap. You can start the next one on ${free.toISOString().slice(0, 10)}.`);
      }
    }
    const row = await tx.listingOffer.create({
      data: {
        listingId: listing.id, sellerBusinessId, kind: d.kind, status: needsReview ? "needs_review" : "draft", terms: d.terms as object, startsAt, endsAt, reviewFlags: flags,
      },
    });
    await emit(tx, "OfferCreated", { type: "offer", id: row.id }, { offerId: row.id, listingId: listing.id, sellerBusinessId, kind: d.kind, needsReview });
    return !needsReview && start ? activateTx(tx, row, ref, now) : row;
  });
  await bustOffers([listing.id]);
  return toView(created);
}

async function requireOffer(id: string): Promise<OfferRow> {
  const o = /^[0-9a-f-]{36}$/i.test(id) ? await prisma.listingOffer.findUnique({ where: { id } }) : null;
  if (!o) throw new DomainError("not_found", "Offer not found");
  return o;
}

export async function getOffer(id: string): Promise<OfferView | null> {
  const o = /^[0-9a-f-]{36}$/i.test(id) ? await prisma.listingOffer.findUnique({ where: { id } }) : null;
  return o ? toView(o) : null;
}

export async function listSellerOffers(sellerBusinessId: string, opts: { limit?: number } = {}): Promise<(OfferView & { listingTitle: string | null })[]> {
  const rows = await prisma.listingOffer.findMany({ where: { sellerBusinessId }, orderBy: { createdAt: "desc" }, take: Math.min(opts.limit ?? 100, 200) });
  const titles = new Map<string, string | null>();
  for (const id of new Set(rows.map((r) => r.listingId))) titles.set(id, (await getListingFacts(id))?.title ?? null);
  return rows.map((r) => ({ ...toView(r), listingTitle: titles.get(r.listingId) ?? null }));
}

export async function listOffersForReview(opts: { status?: OfferStatusName; limit?: number } = {}): Promise<(OfferView & { listingTitle: string | null })[]> {
  const rows = await prisma.listingOffer.findMany({ where: { status: opts.status ?? "needs_review" }, orderBy: { createdAt: "asc" }, take: Math.min(opts.limit ?? 100, 200) });
  const titles = new Map<string, string | null>();
  for (const id of new Set(rows.map((r) => r.listingId))) titles.set(id, (await getListingFacts(id))?.title ?? null);
  return rows.map((r) => ({ ...toView(r), listingTitle: titles.get(r.listingId) ?? null }));
}

/** Re-checks an offer against the listing as it is NOW. Returns the failure text, or null when it is still valid. */
async function stillValid(o: OfferRow, now: Date): Promise<string | null> {
  const listing = await facts(o.listingId);
  if (!listing) return "The listing is no longer live";
  const parsed = offerInputSchema.safeParse({ kind: o.kind, listingId: o.listingId, terms: o.terms, startsAt: o.startsAt, endsAt: o.endsAt });
  if (!parsed.success) return "The offer terms are no longer valid";
  const ref = await referencePrice(o.listingId, now);
  const a = assessOffer(parsed.data, { basePricePaise: listing.pricePaise, moq: listing.moq, referencePaise: ref, floorPaise: offerFloorPaise(listing.categorySlug), startsAt: o.startsAt, endsAt: o.endsAt });
  // timed offers are re-checked for price ordering only: a discount that has become < 3% because the LISTING price changed is also invalid
  return a.errors[0] ?? null;
}

/** Staff decision on a held offer (`offers.review`). Approved offers start now or when scheduled. */
export async function reviewOffer(offerId: string, decision: "approve" | "reject", reviewerId: string, note?: string, now = new Date()): Promise<OfferView> {
  const o = await requireOffer(offerId);
  if (o.status !== "needs_review") throw new DomainError("conflict", "This offer is not waiting for review");
  if (decision === "reject") {
    if (!note?.trim()) throw new DomainError("validation", "A reason is required when rejecting an offer");
    const row = await prisma.$transaction(async (tx) => {
      const r = await tx.listingOffer.update({ where: { id: o.id }, data: { status: "rejected", reviewedBy: reviewerId, reviewNote: note.trim().slice(0, 500) } });
      await emit(tx, "OfferRejected", { type: "offer", id: o.id }, { offerId: o.id, listingId: o.listingId, sellerBusinessId: o.sellerBusinessId, reason: note.trim().slice(0, 500), reviewedBy: reviewerId });
      return r;
    });
    return toView(row);
  }
  const problem = await stillValid(o, now);
  if (problem) throw new DomainError("validation", `Cannot approve: ${problem}`);
  const ref = await referencePrice(o.listingId, now);
  const row = await prisma.$transaction(async (tx) => {
    const held = await tx.listingOffer.updateMany({ where: { id: o.id, status: "needs_review" }, data: { status: "draft", reviewedBy: reviewerId, reviewNote: note?.trim().slice(0, 500) ?? null } });
    if (held.count === 0) throw new DomainError("conflict", "This offer was already decided");
    const fresh = await tx.listingOffer.findUniqueOrThrow({ where: { id: o.id } });
    return fresh.startsAt <= now ? activateTx(tx, fresh, ref, now) : fresh;
  });
  await bustOffers([o.listingId]);
  return toView(row);
}

async function endOffer(o: OfferRow, status: "expired" | "cancelled" | "suspended" | "rejected", reason: "expired" | "cancelled" | "listing_changed" | "suspended", extra: { reviewedBy?: string; note?: string } = {}) {
  const wasActive = o.status === "active";
  const done = await prisma.$transaction(async (tx) => {
    const n = await tx.listingOffer.updateMany({
      where: { id: o.id, status: o.status },
      data: { status, endedReason: reason, ...(extra.reviewedBy ? { reviewedBy: extra.reviewedBy } : {}), ...(extra.note ? { reviewNote: extra.note.slice(0, 500) } : {}) },
    });
    if (n.count === 0) return false;
    if (status === "rejected") await emit(tx, "OfferRejected", { type: "offer", id: o.id }, { offerId: o.id, listingId: o.listingId, sellerBusinessId: o.sellerBusinessId, reason });
    else if (wasActive || status === "expired") await emit(tx, "OfferEnded", { type: "offer", id: o.id }, { offerId: o.id, listingId: o.listingId, sellerBusinessId: o.sellerBusinessId, reason });
    return true;
  });
  if (done) await bustOffers([o.listingId]);
  return done;
}

/** Seller withdraws their own offer at any time (an active one ends immediately). */
export async function cancelOffer(offerId: string, sellerBusinessId: string): Promise<OfferView> {
  const o = await requireOffer(offerId);
  if (o.sellerBusinessId !== sellerBusinessId) throw new DomainError("forbidden", "Not your offer");
  if (!["draft", "needs_review", "active"].includes(o.status)) throw new DomainError("conflict", "This offer has already ended");
  await endOffer(o, "cancelled", "cancelled");
  return (await getOffer(offerId))!;
}

/** Staff suspend an offer (`offers.review`), e.g. after honour reports. */
export async function suspendOffer(offerId: string, staffId: string, note: string): Promise<OfferView> {
  const o = await requireOffer(offerId);
  if (!["draft", "needs_review", "active"].includes(o.status)) throw new DomainError("conflict", "This offer has already ended");
  if (!note.trim()) throw new DomainError("validation", "A reason is required");
  await endOffer(o, "suspended", "suspended", { reviewedBy: staffId, note });
  return (await getOffer(offerId))!;
}

/** Suspends every open offer of a seller (used when honour reports cross the threshold). */
export async function suspendSellerOffers(sellerBusinessId: string, reviewerId: string, note: string): Promise<number> {
  const open = await prisma.listingOffer.findMany({ where: { sellerBusinessId, status: { in: ["draft", "needs_review", "active"] } } });
  let n = 0;
  for (const o of open) if (await endOffer(o, "suspended", "suspended", { reviewedBy: reviewerId, note })) n++;
  return n;
}

/**
 * Listing published a new version, was unpublished, archived or rejected: every open offer is re-validated against the LIVE listing.
 * An invalid one ends with reason `listing_changed` (active -> suspended; not-yet-live -> rejected).
 */
export async function revalidateListingOffers(listingId: string, now = new Date()): Promise<number> {
  const open = await prisma.listingOffer.findMany({ where: { listingId, status: { in: ["draft", "needs_review", "active"] } } });
  let ended = 0;
  for (const o of open) {
    const problem = await stillValid(o, now);
    if (!problem) continue;
    if (await endOffer(o, o.status === "active" ? "suspended" : "rejected", "listing_changed", { note: problem })) ended++;
  }
  if (open.length) await bustOffers([listingId]);
  return ended;
}

/** Job: expire offers past their end, activate scheduled ones that are due (reference price computed AT activation). */
export async function processOffers(now = new Date()): Promise<{ expired: number; activated: number; rejected: number }> {
  let expired = 0;
  let activated = 0;
  let rejected = 0;
  const due = await prisma.listingOffer.findMany({ where: { status: "active", endsAt: { lte: now } }, take: 500 });
  for (const o of due) if (await endOffer(o, "expired", "expired")) expired++;

  const starting = await prisma.listingOffer.findMany({ where: { status: "draft", startsAt: { lte: now } }, take: 500 });
  for (const o of starting) {
    if (o.endsAt && o.endsAt <= now) {
      if (await endOffer(o, "rejected", "expired")) rejected++;
      continue;
    }
    const problem = await stillValid(o, now);
    if (problem) {
      if (await endOffer(o, "rejected", "listing_changed", { note: problem })) rejected++;
      continue;
    }
    const ref = await referencePrice(o.listingId, now);
    const ok = await prisma.$transaction(async (tx) => {
      const fresh = await tx.listingOffer.findUnique({ where: { id: o.id } });
      if (!fresh || fresh.status !== "draft") return false;
      await activateTx(tx, fresh, ref, now);
      return true;
    });
    if (ok) {
      activated++;
      await bustOffers([o.listingId]);
    }
  }
  return { expired, activated, rejected };
}

// ---------------------------------------------------------------------------------------------- public read

export interface PublicOffer {
  listingId: string;
  timed: { offerId: string; unitPricePaise: number; startsAt: string; endsAt: string; reference: { pricePaise: number; percentOff: number } | null } | null;
  tiers: { offerId: string; endsAt: string | null; tiers: { minQty: number; unitPricePaise: number; percentOff: number | null }[]; referencePaise: number | null } | null;
  freeDelivery: { offerId: string; minQty: number | null; minOrderValuePaise: number | null; regions: string[]; endsAt: string | null } | null;
}

/** Shown reference = min(reference at activation, true 30-day low now). Null => show the price only. */
export function shownReference(stored: number | null, current: number | null): number | null {
  if (stored === null || current === null) return null;
  return Math.min(stored, current);
}

async function loadPublicOffer(listingId: string, now: Date): Promise<{ value: PublicOffer | null; ttl: number }> {
  const rows = await prisma.listingOffer.findMany({
    where: { listingId, status: "active", startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
    orderBy: { createdAt: "desc" },
  });
  if (rows.length === 0) return { value: null, ttl: OFFER.cacheSeconds };
  const nowRef = await referencePrice(listingId, now);
  const out: PublicOffer = { listingId, timed: null, tiers: null, freeDelivery: null };
  let ttl: number = OFFER.cacheSeconds;
  for (const o of rows) {
    if (o.endsAt) ttl = Math.max(1, Math.min(ttl, Math.floor((o.endsAt.getTime() - now.getTime()) / 1000)));
    const stored = o.referencePricePaise === null ? null : Number(o.referencePricePaise);
    const ref = shownReference(stored, nowRef);
    if (o.kind === "timed_price" && !out.timed && o.endsAt) {
      const price = (o.terms as { unitPricePaise: number }).unitPricePaise;
      const bps = discountBpsFrom(ref, price);
      out.timed = { offerId: o.id, unitPricePaise: price, startsAt: o.startsAt.toISOString(), endsAt: o.endsAt.toISOString(), reference: bps !== null && ref !== null ? { pricePaise: ref, percentOff: percentOff(bps)! } : null };
    } else if (o.kind === "volume_tiers" && !out.tiers) {
      const tiers = (o.terms as { tiers: { minQty: number; unitPricePaise: number }[] }).tiers;
      out.tiers = { offerId: o.id, endsAt: o.endsAt?.toISOString() ?? null, referencePaise: ref, tiers: tiers.map((t) => ({ ...t, percentOff: percentOff(discountBpsFrom(ref, t.unitPricePaise)) })) };
    } else if (o.kind === "free_delivery_moq" && !out.freeDelivery) {
      const t = o.terms as { minQty?: number; minOrderValuePaise?: number; regions?: string[] };
      out.freeDelivery = { offerId: o.id, minQty: t.minQty ?? null, minOrderValuePaise: t.minOrderValuePaise ?? null, regions: t.regions ?? [], endsAt: o.endsAt?.toISOString() ?? null };
    }
  }
  return { value: out.timed || out.tiers || out.freeDelivery ? out : null, ttl };
}

/**
 * Active offers for a listing (PDP and cards). Cached under `offer:<id>` (+ the listing tag) and hard-purged whenever an offer
 * starts or ends. Never cached past the earliest endsAt, so an ended offer is not shown.
 */
export async function getOfferForListing(listingId: string): Promise<PublicOffer | null> {
  if (!promotionsEnabled() || !/^[0-9a-f-]{36}$/i.test(listingId)) return null;
  const now = new Date();
  const key = `promo:offer:v1:${listingId}`;
  // ttl is decided by the loader (bounded by endsAt); cachedTagged takes a fixed ttl, so use a short one and re-check expiry on hit
  const v = await cachedTagged(key, [promoTags.offer(listingId), cacheTags.listing(listingId), promoTags.offers], OFFER.cacheSeconds, async () => (await loadPublicOffer(listingId, now)).value);
  return v && !expiredNow(v, new Date()) ? v : v ? (await loadPublicOffer(listingId, new Date())).value : null;
}

function expiredNow(v: PublicOffer, now: Date): boolean {
  const ends = [v.timed?.endsAt, v.tiers?.endsAt, v.freeDelivery?.endsAt].filter((x): x is string => !!x);
  return ends.some((e) => new Date(e) <= now);
}

/** Batch form for cards. Order is not significant. */
export async function getOffersForListings(listingIds: string[]): Promise<Map<string, PublicOffer>> {
  const ids = [...new Set(listingIds)].slice(0, 100);
  const found = await Promise.all(ids.map(async (id) => [id, await getOfferForListing(id)] as const));
  return new Map(found.flatMap(([id, o]) => (o ? [[id, o] as const] : [])));
}
