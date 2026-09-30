import { prisma } from "@cnote/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addListing, cleanup, party, world, type Party } from "./helpers";

vi.mock("@cnote/catalogue", async (orig) => {
  const a = await orig<Record<string, unknown>>();
  const { world } = await import("./helpers");
  return {
    ...a,
    listSellerListings: async (id: string) => world.listings.filter((l) => l.sellerBusinessId === id),
    getListing: async (id: string) => world.listings.find((l) => l.id === id) ?? null,
  };
});

import { getPriceBookEntry, listPriceBook, selectPriceBookForRfq, seedPriceBookFromListings, upsertPriceBookEntry } from "../src";

let seller: Party, other: Party;
beforeAll(async () => { seller = await party("s"); other = await party("o"); });
afterAll(cleanup);

describe("price book", () => {
  it("seeds from priced, published listings with floor = base (never discount by default), idempotently", async () => {
    const l = addListing(seller.businessId, { pricePaise: 5000, moq: 100 });
    addListing(seller.businessId, { title: "Draft thing", status: "draft" });
    addListing(seller.businessId, { title: "Unpriced", pricePaise: null });
    expect(await seedPriceBookFromListings(seller.businessId)).toBe(1);
    expect(await seedPriceBookFromListings(seller.businessId)).toBe(0);
    const book = await listPriceBook(seller.businessId);
    expect(book).toHaveLength(1);
    expect(book[0]).toMatchObject({ listingId: l.id, basePricePaise: 5000, floorPricePaise: 5000, unit: "pcs", moq: 100, leadTimeDays: 7, validityDays: 7, seeded: true, active: true, tiers: [] });
    expect(await seedPriceBookFromListings(other.businessId)).toBe(0);
  });

  it("upsert validates, keeps the floor private to the owner, marks the entry as edited, and refuses foreign listings", async () => {
    const [entry] = await listPriceBook(seller.businessId);
    const input = { basePricePaise: 5000, unit: "pcs", tiers: [{ minQty: 1000, pricePaise: 4500 }, { minQty: 500, pricePaise: 4800 }], floorPricePaise: 4200, moq: 100, leadTimeDays: 5, deliveryTerms: "Freight extra", gstPercent: 18, gstIncluded: false, validityDays: 10 };
    const saved = await upsertPriceBookEntry(seller, entry!.listingId, input);
    expect(saved).toMatchObject({ seeded: false, floorPricePaise: 4200, leadTimeDays: 5, tiers: [{ minQty: 500, pricePaise: 4800 }, { minQty: 1000, pricePaise: 4500 }] });
    expect((await prisma.sellerPriceBook.count({ where: { sellerBusinessId: seller.businessId } }))).toBe(1);
    await expect(upsertPriceBookEntry(seller, entry!.listingId, { ...input, floorPricePaise: 9000 })).rejects.toMatchObject({ code: "validation" });
    await expect(upsertPriceBookEntry(seller, entry!.listingId, { ...input, tiers: [{ minQty: 10, pricePaise: 100 }] })).rejects.toMatchObject({ code: "validation" });
    await expect(upsertPriceBookEntry(seller, entry!.listingId, { ...input, unit: "" })).rejects.toMatchObject({ code: "validation" });
    await expect(upsertPriceBookEntry(other, entry!.listingId, input)).rejects.toMatchObject({ code: "not_found" });
    await expect(upsertPriceBookEntry(seller, "not-a-uuid", input)).rejects.toMatchObject({ code: "not_found" });
    expect(await getPriceBookEntry(other.businessId, saved.id)).toBeNull();
    expect(await getPriceBookEntry(seller.businessId, "bad")).toBeNull();
    expect((await getPriceBookEntry(seller.businessId, saved.id))?.floorPricePaise).toBe(4200);
    // reseeding never overwrites a seller-edited entry
    await seedPriceBookFromListings(seller.businessId);
    expect((await getPriceBookEntry(seller.businessId, saved.id))?.floorPricePaise).toBe(4200);
  });

  it("selects the entry for an RFQ by category and title overlap; ignores inactive and out-of-category entries", async () => {
    const s = await party("sel");
    const boxes = addListing(s.businessId, { title: "Corrugated shipping boxes", description: "3 ply boxes", updatedAt: "2026-01-01T00:00:00Z" });
    const bags = addListing(s.businessId, { title: "Jute carry bags", description: "jute bags", category: { id: "x", slug: "bags", name: "Bags" } });
    const boxes2 = addListing(s.businessId, { title: "Plain paper", description: "paper", updatedAt: "2026-02-01T00:00:00Z" });
    await seedPriceBookFromListings(s.businessId);
    const pick = await selectPriceBookForRfq(s.businessId, { title: "Need corrugated boxes", requirement: "3 ply shipping boxes", categorySlug: "boxes" });
    expect(pick?.listingId).toBe(boxes.id);
    expect((await selectPriceBookForRfq(s.businessId, { title: "jute bags", requirement: "jute", categorySlug: "bags" }))?.listingId).toBe(bags.id);
    // no category on the RFQ: still picks the best title overlap
    expect((await selectPriceBookForRfq(s.businessId, { title: "corrugated boxes", requirement: "", categorySlug: null }))?.listingId).toBe(boxes.id);
    expect(await selectPriceBookForRfq(s.businessId, { title: "x", requirement: "y", categorySlug: "machines" })).toBeNull();
    // ties break to the most recently updated listing
    expect((await selectPriceBookForRfq(s.businessId, { title: "zzz", requirement: "zzz", categorySlug: "boxes" }))?.listingId).toBe(boxes2.id);
    await prisma.sellerPriceBook.updateMany({ where: { sellerBusinessId: s.businessId }, data: { active: false } });
    expect(await selectPriceBookForRfq(s.businessId, { title: "corrugated boxes", requirement: "", categorySlug: "boxes" })).toBeNull();
    expect(await selectPriceBookForRfq((await party("empty")).businessId, { title: "a", requirement: "b", categorySlug: null })).toBeNull();
    world.listings.length = 0;
  });
});
