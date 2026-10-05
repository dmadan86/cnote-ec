// Stock fast path + variant management (docs/design/variants-stock.md).
//
// Variants: STRUCTURE is saved on the working copy (setListingVariants) and reaches buyers through the normal version flow
// (snapshot -> moderation -> publisher, ADR-033). STOCK (availability, quantity, lead time) is operational: it is written to the
// working copy and converged into LIVE straight away (updateListingStock / syncLiveStock), announced with
// ListingAvailabilityChanged, and re-asserted on every publish and by the hourly reconcile. LIVE is written inside the authoring
// transaction before it commits (the same order as the publisher): a failed commit can only leave LIVE ahead, which reconcile heals.
import { DomainError, emit } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { liveDb } from "@cnote/live-db";
import { z } from "zod";
import { isAvailability, validateStock, type Availability } from "./availability";
import { bustListingCaches } from "./cache";
import { getCategoryById } from "./categories";
import { refreshLiveStock, type WorkingStock } from "./live-stock";
import { isUuid, listingInclude, toListingView, toSellerVariants, type ListingRow } from "./mappers";
import { categoryAxes, normaliseVariants, parseAxes, parseVariants, variantInputSchema, MAX_VARIANTS, type SellerVariantView, type VariantInput } from "./variants";
import { parseOrThrow } from "./validate";
import type { ListingView } from "./index";

type Tx = Prisma.TransactionClient;

async function loadOwned(sellerBusinessId: string, listingId: string): Promise<ListingRow> {
  const row = isUuid(listingId) ? await prisma.listing.findUnique({ where: { id: listingId }, include: listingInclude }) : null;
  if (!row) throw new DomainError("not_found", "Listing not found", undefined, "ads.listingNotFound");
  if (row.sellerBusinessId !== sellerBusinessId) throw new DomainError("forbidden", "Not your listing");
  return row;
}

/** Key-order-independent JSON (jsonb does not preserve key order, so a plain stringify compare would always differ). */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => `${JSON.stringify(k)}:${canon(x)}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

const lockListing = (tx: Tx, listingId: string) => tx.$queryRaw`SELECT id FROM listings WHERE id = ${listingId}::uuid FOR UPDATE`;

/** The seller's variants of one listing (working copy), in display order. */
export async function listingVariantsForSeller(sellerBusinessId: string, listingId: string): Promise<SellerVariantView[]> {
  return toSellerVariants((await loadOwned(sellerBusinessId, listingId)).variants);
}

// ---------------------------------------------------------------------------------------------- LIVE convergence

/**
 * Converges the LIVE row of a listing on the working copy's current stock (only stock: variants are never added or removed here)
 * and, when the EFFECTIVE availability changed, emits ListingAvailabilityChanged in the caller's transaction.
 * No-op when the listing is not live. `leadTimeDays` (when not undefined) is also written to the live trade info: it is the one
 * content-adjacent number the seller may change together with a made-to-order switch.
 */
export async function syncLiveStock(
  tx: Tx,
  listingId: string,
  opts: { leadTimeDays?: number | null; variantId?: string | null; emitEvent?: boolean } = {},
): Promise<{ changed: boolean; from: Availability | null; to: Availability | null }> {
  const l = await tx.listing.findUnique({ where: { id: listingId }, include: { variants: true } });
  if (!l?.liveVersionId) return { changed: false, from: null, to: null };
  const live = await liveDb.liveListing.findUnique({ where: { id: listingId } });
  if (!live) return { changed: false, from: null, to: null };

  const working: WorkingStock = { availability: l.availability, availableQty: l.availableQty, stockUpdatedAt: l.stockUpdatedAt, variants: l.variants };
  const next = refreshLiveStock({ variants: parseVariants(live.variants), variantAxes: parseAxes(live.variantAxes) }, working);
  const from: Availability = isAvailability(live.availability) ? live.availability : "in_stock";
  const trade = { ...(live.trade && typeof live.trade === "object" && !Array.isArray(live.trade) ? (live.trade as Record<string, unknown>) : {}) };
  if (opts.leadTimeDays !== undefined) {
    if (opts.leadTimeDays === null) delete trade.leadTimeDays;
    else trade.leadTimeDays = opts.leadTimeDays;
  }
  const variantsJson = JSON.stringify(next.variants);
  const tradeJson = JSON.stringify(trade);
  const sameStock =
    live.availability === next.availability &&
    live.availableQty === next.availableQty &&
    (live.stockUpdatedAt?.getTime() ?? null) === (next.stockUpdatedAt?.getTime() ?? null) &&
    canon(live.variants) === canon(next.variants) &&
    canon(live.trade) === canon(trade);
  if (sameStock) return { changed: false, from, to: from };

  await liveDb.$executeRaw`
    UPDATE live_listings SET availability = ${next.availability}, available_qty = ${next.availableQty}::int, stock_updated_at = ${next.stockUpdatedAt}::timestamptz,
      variants = ${variantsJson}::jsonb, trade = ${tradeJson}::jsonb, updated_at = now()
    WHERE id = ${listingId}::uuid`;
  if (from !== next.availability && opts.emitEvent !== false) {
    await emit(tx, "ListingAvailabilityChanged", { type: "listing", id: listingId }, {
      listingId, sellerBusinessId: l.sellerBusinessId, fromAvailability: from, toAvailability: next.availability, availableQty: next.availableQty, variantId: opts.variantId ?? null,
    });
  }
  return { changed: true, from, to: next.availability };
}

/** Reconcile hook: re-asserts the working copy's stock on a live listing (no event: the change was announced when it was made). */
export async function reprojectStock(listingId: string): Promise<boolean> {
  if (!isUuid(listingId)) return false;
  const res = await prisma.$transaction(async (tx) => {
    await lockListing(tx, listingId);
    return syncLiveStock(tx, listingId, { emitEvent: false });
  });
  if (res.changed) {
    const l = await prisma.listing.findUnique({ where: { id: listingId }, select: { sellerBusinessId: true } });
    await bustListingCaches(listingId, l?.sellerBusinessId);
  }
  return res.changed;
}

// ---------------------------------------------------------------------------------------------- stock fast path

export interface StockUpdate {
  availability?: Availability;
  /** units on hand; null clears it */
  availableQty?: number | null;
  /** listing lead time in days (required, here or already stored, for made_to_order) */
  leadTimeDays?: number | null;
  /** per-variant changes, matched by `id` or `sku` */
  variants?: { id?: string; sku?: string; availability?: Availability; availableQty?: number | null; leadTimeDays?: number | null }[];
}

const stockUpdateSchema = z.object({
  availability: z.enum(["in_stock", "made_to_order", "out_of_stock"]).optional(),
  availableQty: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  leadTimeDays: z.number().int().min(0).max(730).nullable().optional(),
  variants: z
    .array(
      z.object({
        id: z.uuid().optional(),
        sku: z.string().max(64).optional(),
        availability: z.enum(["in_stock", "made_to_order", "out_of_stock"]).optional(),
        availableQty: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
        leadTimeDays: z.number().int().min(0).max(730).nullable().optional(),
      }),
    )
    .max(MAX_VARIANTS)
    .optional(),
});

/**
 * Qty that stays consistent with a state the caller just chose: switching to out_of_stock clears it, and "in stock" never
 * keeps a stored 0 (a one-click toggle must not be refused because of a leftover number).
 */
function qtyAfter(next: Availability, explicit: number | null | undefined, stored: number | null): number | null {
  if (explicit !== undefined) return explicit;
  if (next === "out_of_stock") return null;
  return stored === 0 ? null : stored;
}

/**
 * Seller changes stock: listing-level and/or per variant. Takes effect on LIVE immediately (no review: stock is operational,
 * not content). made_to_order needs a lead time (own, or the listing's). Emits ListingAvailabilityChanged when the effective
 * availability buyers see changes. Returns the seller's working-copy view.
 */
export async function updateListingStock(sellerBusinessId: string, listingId: string, update: StockUpdate, now = new Date()): Promise<ListingView> {
  const patch = parseOrThrow(stockUpdateSchema, update);
  const cur = await loadOwned(sellerBusinessId, listingId);
  if (cur.status === "archived") throw new DomainError("conflict", "Archived listings cannot be edited");
  if (patch.variants?.length && !cur.variants.length) throw new DomainError("validation", "This listing has no variants", undefined, "catalogue.noVariants");

  let causedBy: string | null = null;
  await prisma.$transaction(
    async (tx) => {
      await lockListing(tx, cur.id);
      const fresh = await tx.listing.findUniqueOrThrow({ where: { id: cur.id }, include: { variants: true } });
      const errors: string[] = [];

      const lead = patch.leadTimeDays !== undefined ? patch.leadTimeDays : fresh.leadTimeDays;
      const ownAvail = patch.availability ?? fresh.availability;
      const ownQty = qtyAfter(ownAvail, patch.availableQty, fresh.availableQty);
      const ownChanged = ownAvail !== fresh.availability || ownQty !== fresh.availableQty || lead !== fresh.leadTimeDays;
      if (!fresh.variants.length || patch.availability !== undefined || patch.availableQty !== undefined) errors.push(...validateStock({ availability: ownAvail, availableQty: ownQty, leadTimeDays: lead }, "Stock"));

      const variantWrites: { id: string; data: Prisma.ListingVariantUncheckedUpdateInput }[] = [];
      for (const p of patch.variants ?? []) {
        const row = fresh.variants.find((v) => (p.id ? v.id === p.id : p.sku !== undefined && v.sku === p.sku));
        if (!row) {
          errors.push(`Variant ${p.id ?? p.sku ?? "?"} not found`);
          continue;
        }
        const a = p.availability ?? row.availability;
        const q = qtyAfter(a, p.availableQty, row.availableQty);
        const l = p.leadTimeDays !== undefined ? p.leadTimeDays : row.leadTimeDays;
        errors.push(...validateStock({ availability: a, availableQty: q, leadTimeDays: l ?? lead }, `Variant ${row.sku}`));
        if (a !== row.availability || q !== row.availableQty || l !== row.leadTimeDays) variantWrites.push({ id: row.id, data: { availability: a, availableQty: q, leadTimeDays: l, stockUpdatedAt: now } });
      }
      if (errors.length) throw new DomainError("validation", errors.join("; "), errors);
      if (!ownChanged && !variantWrites.length) return;

      if (ownChanged) await tx.listing.update({ where: { id: cur.id }, data: { availability: ownAvail, availableQty: ownQty, leadTimeDays: lead, stockUpdatedAt: now } });
      for (const w of variantWrites) await tx.listingVariant.update({ where: { id: w.id }, data: w.data });
      causedBy = !ownChanged && variantWrites.length === 1 ? variantWrites[0]!.id : null;
      await syncLiveStock(tx, cur.id, { ...(patch.leadTimeDays !== undefined ? { leadTimeDays: patch.leadTimeDays } : {}), variantId: causedBy });
    },
    { timeout: 20_000, maxWait: 10_000 },
  );
  await bustListingCaches(cur.id, cur.sellerBusinessId);
  return toListingView(await prisma.listing.findUniqueOrThrow({ where: { id: cur.id }, include: listingInclude }));
}

// ---------------------------------------------------------------------------------------------- variant structure

/**
 * Replaces the listing's variant set (0..100) with `inputs`. Variants are matched to existing ones by `id`, else by `sku`, so ids
 * (and any quote or alert pointing at them) survive edits; ones not mentioned are deleted. Validated against the category's
 * variant axes. This edits the WORKING COPY: structure reaches buyers only through submitListingVersion (moderation applies, per
 * ADR-033). Stock fields in the input are operational and are converged into LIVE straight away.
 */
export async function setListingVariants(sellerBusinessId: string, listingId: string, inputs: VariantInput[], now = new Date()): Promise<SellerVariantView[]> {
  const parsed = parseOrThrow(z.array(variantInputSchema).max(MAX_VARIANTS), inputs);
  const cur = await loadOwned(sellerBusinessId, listingId);
  if (cur.status === "archived") throw new DomainError("conflict", "Archived listings cannot be edited");
  const category = await getCategoryById(cur.categoryId);
  if (!category) throw new DomainError("validation", "Unknown category", undefined, "ads.unknownCategory");

  const { variants, errors } = normaliseVariants(categoryAxes(category.attributeSchema), parsed, { listingMoq: cur.moq, listingLeadTimeDays: cur.leadTimeDays });
  const imageIds = [...new Set(variants.flatMap((v) => (v.imageId ? [v.imageId] : [])))];
  if (imageIds.length) {
    const found = await prisma.listingImage.findMany({ where: { listingId: cur.id, id: { in: imageIds }, deletedAt: null }, select: { id: true } });
    const ok = new Set(found.map((i) => i.id));
    for (const v of variants) if (v.imageId && !ok.has(v.imageId)) errors.push(`Variant ${v.sku}: image does not belong to this listing`);
  }
  if (errors.length) throw new DomainError("validation", errors.join("; "), errors);

  await prisma.$transaction(
    async (tx) => {
      await lockListing(tx, cur.id);
      const existing = await tx.listingVariant.findMany({ where: { listingId: cur.id } });
      const byId = new Map(existing.map((v) => [v.id, v]));
      const bySku = new Map(existing.map((v) => [v.sku, v]));
      const claimed = new Set<string>();
      const plan = variants.map((v, i) => {
        const match = (v.id ? byId.get(v.id) : undefined) ?? bySku.get(v.sku);
        if (match && claimed.has(match.id)) throw new DomainError("validation", `Variant ${v.sku}: id or SKU matches another variant in this request`);
        if (match) claimed.add(match.id);
        return { v, i, match };
      });
      const removed = existing.filter((e) => !claimed.has(e.id)).map((e) => e.id);
      if (removed.length) await tx.listingVariant.deleteMany({ where: { id: { in: removed } } });
      // free SKUs that are about to move so a swap (A->B, B->A) cannot trip the unique index
      for (const p of plan) if (p.match && p.match.sku !== p.v.sku) await tx.listingVariant.update({ where: { id: p.match.id }, data: { sku: `~${p.match.id}` } });
      for (const { v, i, match } of plan) {
        const data = {
          sku: v.sku,
          axisValues: v.axisValues as Prisma.InputJsonValue,
          pricePaise: v.pricePaise === null ? null : BigInt(v.pricePaise),
          priceTiers: v.priceTiers as unknown as Prisma.InputJsonValue,
          moq: v.moq,
          availability: v.availability,
          availableQty: v.availableQty,
          leadTimeDays: v.leadTimeDays,
          imageId: v.imageId,
          sortOrder: i,
        };
        if (!match) {
          await tx.listingVariant.create({ data: { ...data, listingId: cur.id, stockUpdatedAt: now } });
          continue;
        }
        const stockChanged = match.availability !== v.availability || match.availableQty !== v.availableQty || match.leadTimeDays !== v.leadTimeDays;
        await tx.listingVariant.update({ where: { id: match.id }, data: { ...data, ...(stockChanged ? { stockUpdatedAt: now } : {}) } });
      }
      await syncLiveStock(tx, cur.id);
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
  await bustListingCaches(cur.id, cur.sellerBusinessId);
  return listingVariantsForSeller(sellerBusinessId, cur.id);
}
