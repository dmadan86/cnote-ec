// Price facts for ADR-022 (price intelligence). A narrow, read-only feed of quote/order prices with their category and
// delivery area, for aggregation by @cnote/prices.
//
// PRIVACY CONTRACT: `sellerBusinessId` / `buyerBusinessId` are included ONLY so the aggregator can count DISTINCT
// counterparties (k-anonymity, dominance rule). Callers must never store, log, return or otherwise expose them.
import { prisma } from "@cnote/db";

export interface PriceFact {
  /** quote id or order id (unique within `source`) */
  id: string;
  source: "quote" | "order";
  /** true for orders funded through escrow (real transactions); quotes are always false */
  escrow: boolean;
  /** for orders: the quote they were created from (aggregators drop the quote fact to avoid double counting) */
  quoteId: string | null;
  categoryId: string;
  /** per unit, paise */
  pricePaise: number;
  quantity: number;
  unit: string;
  deliveryPincode: string | null;
  deliveryCity: string | null;
  createdAt: Date;
  /** aggregation-only: never expose */
  sellerBusinessId: string;
  /** aggregation-only: never expose */
  buyerBusinessId: string;
}

export interface PriceFactsOptions {
  source: "quote" | "order";
  since: Date;
  until?: Date;
  /** keyset cursor: the last `id` of the previous page */
  after?: string | null;
  limit?: number;
}

/**
 * One keyset-paged (by id) page of price facts created in [since, until). Quotes come from every quote on a categorised
 * enquiry; orders are escrow-settled, non-cancelled orders that carry a per-unit price on a categorised enquiry.
 */
export async function listPriceFacts(opts: PriceFactsOptions): Promise<{ items: PriceFact[]; nextCursor: string | null }> {
  const take = Math.max(1, Math.min(1000, Math.trunc(opts.limit ?? 500)));
  const createdAt = { gte: opts.since, ...(opts.until ? { lt: opts.until } : {}) };
  const idFilter = opts.after ? { gt: opts.after } : undefined;

  if (opts.source === "quote") {
    const rows = await prisma.quote.findMany({
      where: { createdAt, ...(idFilter ? { id: idFilter } : {}), pricePaise: { gt: 0 }, quantity: { gt: 0 }, conversation: { match: { enquiry: { categoryId: { not: null } } } } },
      orderBy: { id: "asc" },
      take: take + 1,
      select: {
        id: true, pricePaise: true, quantity: true, unit: true, createdAt: true, sellerBusinessId: true,
        conversation: { select: { match: { select: { enquiry: { select: { categoryId: true, deliveryPincode: true, deliveryCity: true, buyerBusinessId: true } } } } } },
      },
    });
    const page = rows.slice(0, take);
    const items: PriceFact[] = [];
    for (const r of page) {
      const e = r.conversation.match.enquiry;
      if (!e.categoryId) continue;
      items.push({
        id: r.id, source: "quote", escrow: false, quoteId: null, categoryId: e.categoryId, pricePaise: Number(r.pricePaise), quantity: r.quantity, unit: r.unit,
        deliveryPincode: e.deliveryPincode, deliveryCity: e.deliveryCity, createdAt: r.createdAt, sellerBusinessId: r.sellerBusinessId, buyerBusinessId: e.buyerBusinessId,
      });
    }
    return { items, nextCursor: rows.length > take ? page[page.length - 1]!.id : null };
  }

  const rows = await prisma.order.findMany({
    where: {
      createdAt, ...(idFilter ? { id: idFilter } : {}), settlement: "escrow", status: { not: "cancelled" },
      enquiryId: { not: null }, pricePaise: { gt: 0 }, quantity: { gt: 0 }, unit: { not: null },
    },
    orderBy: { id: "asc" },
    take: take + 1,
  });
  const page = rows.slice(0, take);
  const enquiries = await prisma.enquiry.findMany({
    where: { id: { in: page.map((r) => r.enquiryId!).filter(Boolean) }, categoryId: { not: null } },
    select: { id: true, categoryId: true, deliveryPincode: true, deliveryCity: true },
  });
  const byId = new Map(enquiries.map((e) => [e.id, e]));
  const items: PriceFact[] = [];
  for (const r of page) {
    const e = byId.get(r.enquiryId!);
    if (!e?.categoryId) continue;
    items.push({
      id: r.id, source: "order", escrow: true, quoteId: r.quoteId, categoryId: e.categoryId, pricePaise: Number(r.pricePaise), quantity: r.quantity!, unit: r.unit!,
      deliveryPincode: e.deliveryPincode, deliveryCity: e.deliveryCity, createdAt: r.createdAt, sellerBusinessId: r.sellerBusinessId, buyerBusinessId: r.buyerBusinessId,
    });
  }
  return { items, nextCursor: rows.length > take ? page[page.length - 1]!.id : null };
}
