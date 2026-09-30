// Seller price book (ADR-014): per-listing base price, volume tiers, PRIVATE floor, MOQ, lead time, delivery terms, validity.
// Default-seeded from the seller's live listing price through catalogue's public API; the floor defaults to the base price
// so the agent never discounts until the seller says how far it may go.
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import * as catalogue from "@cnote/catalogue";
import { z } from "zod";
import { DEFAULT_FLOOR_RATIO, parseTiers, priceBookProblems, type PriceTier } from "./bounds";
import { isUuid, json, type Actor } from "./common";

export interface PriceBookView {
  id: string;
  listingId: string;
  title: string;
  basePricePaise: number;
  unit: string;
  tiers: PriceTier[];
  /** private to the seller: never sent to buyers */
  floorPricePaise: number;
  moq: number | null;
  leadTimeDays: number;
  deliveryTerms: string | null;
  gstPercent: number | null;
  gstIncluded: boolean;
  validityDays: number;
  seeded: boolean;
  active: boolean;
  updatedAt: string;
}

type Row = Awaited<ReturnType<typeof prisma.sellerPriceBook.findFirstOrThrow>>;
export const toPriceBookView = (r: Row): PriceBookView => ({
  id: r.id, listingId: r.listingId, title: r.title, basePricePaise: Number(r.basePricePaise), unit: r.unit, tiers: parseTiers(r.tiers),
  floorPricePaise: Number(r.floorPricePaise), moq: r.moq, leadTimeDays: r.leadTimeDays, deliveryTerms: r.deliveryTerms, gstPercent: r.gstPercent,
  gstIncluded: r.gstIncluded, validityDays: r.validityDays, seeded: r.seeded, active: r.active, updatedAt: r.updatedAt.toISOString(),
});

/** Creates entries for the seller's priced, published listings that have none yet. Idempotent; never touches existing entries. */
export async function seedPriceBookFromListings(sellerBusinessId: string): Promise<number> {
  const listings = (await catalogue.listSellerListings(sellerBusinessId)).filter((l) => l.status === "published" && l.pricePaise != null && l.pricePaise > 0 && l.priceUnit);
  if (listings.length === 0) return 0;
  const existing = new Set((await prisma.sellerPriceBook.findMany({ where: { sellerBusinessId }, select: { listingId: true } })).map((e) => e.listingId));
  const fresh = listings.filter((l) => !existing.has(l.id));
  if (fresh.length === 0) return 0;
  const { count } = await prisma.sellerPriceBook.createMany({
    skipDuplicates: true,
    data: fresh.map((l) => ({
      sellerBusinessId, listingId: l.id, title: l.title, basePricePaise: BigInt(l.pricePaise!), unit: l.priceUnit!,
      floorPricePaise: BigInt(Math.max(1, Math.round(l.pricePaise! * DEFAULT_FLOOR_RATIO))), moq: l.moq && l.moq > 0 ? l.moq : null,
    })),
  });
  return count;
}

/** The seller's price book (seeds missing entries from live listings first). */
export async function listPriceBook(sellerBusinessId: string): Promise<PriceBookView[]> {
  await seedPriceBookFromListings(sellerBusinessId);
  const rows = await prisma.sellerPriceBook.findMany({ where: { sellerBusinessId }, orderBy: { title: "asc" } });
  return rows.map(toPriceBookView);
}

export async function getPriceBookEntry(sellerBusinessId: string, id: string): Promise<PriceBookView | null> {
  if (!isUuid(id)) return null;
  const r = await prisma.sellerPriceBook.findFirst({ where: { id, sellerBusinessId } });
  return r ? toPriceBookView(r) : null;
}

const tierSchema = z.object({ minQty: z.number().int(), pricePaise: z.number().int() });
export const priceBookInputSchema = z.object({
  basePricePaise: z.number().int().positive().max(10_000_000_000_00),
  unit: z.string().trim().min(1).max(20),
  tiers: z.array(tierSchema).max(8).default([]),
  floorPricePaise: z.number().int().positive().max(10_000_000_000_00),
  moq: z.number().int().positive().max(2_000_000_000).nullish().transform((v) => v ?? null),
  leadTimeDays: z.number().int().min(0).max(365),
  deliveryTerms: z.string().trim().max(300).nullish().transform((v) => v || null),
  gstPercent: z.number().int().min(0).max(40).nullish().transform((v) => v ?? null),
  gstIncluded: z.boolean().default(false),
  validityDays: z.number().int().min(1).max(90),
  active: z.boolean().default(true),
});
export type PriceBookInput = z.input<typeof priceBookInputSchema>;

/** Create or update the entry for one of the seller's own listings. Validated: tiers fall as quantity rises, nothing under the floor. */
export async function upsertPriceBookEntry(actor: Actor, listingId: string, input: PriceBookInput): Promise<PriceBookView> {
  const parsed = priceBookInputSchema.safeParse(input);
  if (!parsed.success) throw new DomainError("validation", parsed.error.issues[0]?.message ?? "Invalid price book entry");
  const v = { ...parsed.data, tiers: [...parsed.data.tiers].sort((a, b) => a.minQty - b.minQty) };
  const problems = priceBookProblems(v);
  if (problems.length) throw new DomainError("validation", problems[0]!, problems);
  const listing = isUuid(listingId) ? await catalogue.getListing(listingId) : null;
  if (!listing || listing.sellerBusinessId !== actor.businessId) throw new DomainError("not_found", "Listing not found", undefined, "ads.listingNotFound");
  const tiers = v.tiers;
  const data = {
    title: listing.title, basePricePaise: BigInt(v.basePricePaise), unit: v.unit, tiers: json(tiers), floorPricePaise: BigInt(v.floorPricePaise), moq: v.moq,
    leadTimeDays: v.leadTimeDays, deliveryTerms: v.deliveryTerms, gstPercent: v.gstPercent, gstIncluded: v.gstIncluded, validityDays: v.validityDays, active: v.active, seeded: false,
  };
  const row = await prisma.sellerPriceBook.upsert({
    where: { sellerBusinessId_listingId: { sellerBusinessId: actor.businessId, listingId } },
    create: { sellerBusinessId: actor.businessId, listingId, ...data }, update: data,
  });
  return toPriceBookView(row);
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9ऀ-ॿ]+/).filter((w) => w.length >= 3));

/**
 * Which price book entry answers this RFQ: an active entry whose listing is in the RFQ's category, best title overlap first.
 * Returns null when nothing fits (the agent then declines to price rather than guessing).
 */
export async function selectPriceBookForRfq(sellerBusinessId: string, rfq: { title: string; requirement: string; categorySlug: string | null }): Promise<PriceBookView | null> {
  await seedPriceBookFromListings(sellerBusinessId);
  const entries = (await prisma.sellerPriceBook.findMany({ where: { sellerBusinessId, active: true } })).map(toPriceBookView);
  if (entries.length === 0) return null;
  const listings = new Map((await catalogue.listSellerListings(sellerBusinessId)).filter((l) => l.status === "published").map((l) => [l.id, l]));
  const want = words(`${rfq.title} ${rfq.requirement}`);
  const scored = entries
    .map((e) => ({ e, l: listings.get(e.listingId) }))
    .filter((x): x is { e: PriceBookView; l: catalogue.ListingView } => !!x.l && (!rfq.categorySlug || x.l.category.slug === rfq.categorySlug))
    .map(({ e, l }) => ({ e, score: [...words(`${l.title} ${l.description}`)].filter((w) => want.has(w)).length, at: l.updatedAt }));
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score || b.at.localeCompare(a.at));
  return scored[0]!.e;
}

