import { prisma } from "@cnote/db";
import { getConversation, getQuote, sendQuote } from "@cnote/enquiry";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { acceptedLead, addListing, cleanup, party, world, type Party } from "./helpers";

vi.mock("@cnote/catalogue", async (orig) => {
  const a = await orig<Record<string, unknown>>();
  const { world } = await import("./helpers");
  return {
    ...a,
    listSellerListings: async (id: string) => world.listings.filter((l) => l.sellerBusinessId === id),
    getListing: async (id: string) => world.listings.find((l) => l.id === id) ?? null,
  };
});

import { approveDraft, compareQuotes, generateDraft, upsertPriceBookEntry } from "../src";

let buyer: Party, seller: Party;

beforeAll(async () => {
  vi.stubEnv("QUOTE_ASSIST_ENABLED", "true");
  buyer = await party("buyer");
  seller = await party("seller");
  const listingId = addListing(seller.businessId).id;
  await upsertPriceBookEntry(seller, listingId, {
    basePricePaise: 5000, unit: "pcs", tiers: [], floorPricePaise: 4200, moq: 100, leadTimeDays: 7, deliveryTerms: "Ex-works Pune", gstPercent: 18, gstIncluded: false, validityDays: 7,
  });
});
afterAll(cleanup);

describe("approved drafts become structured quotes", () => {
  it("sends MOQ, delivery and GST as fields (not folded into notes) and links the quote id without diffing", async () => {
    const l = await acceptedLead(buyer, seller, { quantity: 600 });
    const d = (await generateDraft(seller.businessId, l.matchId))!;
    const out = await approveDraft(seller, d.id, { shippingTerms: "Ex-works Pune", notes: "Thanks" });
    expect(out.quoteId).toBeTruthy();
    const q = (await getQuote(seller, out.quoteId!))!;
    expect(q).toMatchObject({ moq: 100, moqUnit: "pcs", deliveryTerms: "ex_works", deliveryNote: "Ex-works Pune", gstIncluded: false, notes: "Thanks" });
    expect((await getConversation(buyer, l.conversationId!))!.quotes.map((x) => x.id)).toEqual([out.quoteId]);
  });
});

describe("compareQuotes with structured terms", () => {
  it("uses structured terms directly, falls back to notes extraction for old quotes", async () => {
    const e = await prisma.enquiry.create({ data: { buyerBusinessId: buyer.businessId, buyerPersonId: buyer.personId, title: "Boxes", requirement: "Need 3 ply boxes for shipping", quantity: 100, quantityUnit: "pcs", status: "matched" } });
    world.enquiryIds.push(e.id);
    const s2 = await party("s2");
    const convs: string[] = [];
    for (const s of [seller, s2]) {
      const m = await prisma.match.create({ data: { enquiryId: e.id, sellerBusinessId: s.businessId, rank: convs.length + 1, matchScore: 0.9, status: "accepted", respondBy: new Date(Date.now() + 3_600_000), respondedAt: new Date() } });
      convs.push((await prisma.conversation.create({ data: { matchId: m.id } })).id);
    }
    const structured = await sendQuote(seller, convs[0]!, {
      pricePaise: 5000, quantity: 100, unit: "pcs", leadTimeDays: 5, moq: 50, moqUnit: "pcs", deliveryTerms: "door_delivery", deliveryChargePaise: 100000, paymentTerms: "net_15", gstIncluded: true,
    });
    const old = await sendQuote(s2, convs[1]!, { pricePaise: 4800, quantity: 100, unit: "pcs", leadTimeDays: 9, notes: "Free delivery. GST inclusive." });

    const cmp = await compareQuotes(buyer, e.id);
    const a = cmp.rows.find((r) => r.quoteId === structured.quoteId)!;
    const b = cmp.rows.find((r) => r.quoteId === old.quoteId)!;
    expect(a).toMatchObject({
      structured: true, moq: 50, deliveryTerms: "door_delivery", paymentTermsCode: "net_15", paymentTerms: "net_15", deliveryChargePaise: 100000, gstIncluded: true, landedPaise: 5000 + 1000, landedComplete: true,
    });
    expect(b).toMatchObject({ structured: false, moq: null, paymentTermsCode: null });
    // structured quotes are never sent through the extractor
    expect(await prisma.quoteTerms.findUnique({ where: { quoteId: structured.quoteId } })).toBeNull();
    expect(await prisma.quoteTerms.findUnique({ where: { quoteId: old.quoteId } })).not.toBeNull();
  });
});
