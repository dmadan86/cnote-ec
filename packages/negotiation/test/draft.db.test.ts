import { heuristicQuoteProviders, setQuoteProvidersForTests, type QuoteProviders } from "@cnote/ai";
import { prisma } from "@cnote/db";
import { getConversation } from "@cnote/enquiry";
import * as fc from "fast-check";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { acceptedLead, addListing, cleanup, events, party, world, type Party } from "./helpers";

vi.mock("@cnote/catalogue", async (orig) => {
  const a = await orig<Record<string, unknown>>();
  const { world } = await import("./helpers");
  return {
    ...a,
    listSellerListings: async (id: string) => world.listings.filter((l) => l.sellerBusinessId === id),
    getListing: async (id: string) => world.listings.find((l) => l.id === id) ?? null,
  };
});

import { approveDraft, approveDraftFromChannel, discardDraft, generateDraft, getDraftForMatch, listAgentActions, requestDraft, upsertPriceBookEntry } from "../src";

let buyer: Party, seller: Party, stranger: Party;
let listingId: string;
const book = { basePricePaise: 5000, unit: "pcs", tiers: [{ minQty: 500, pricePaise: 4800 }], floorPricePaise: 4200, moq: 100, leadTimeDays: 7, deliveryTerms: "Freight extra", gstPercent: 18, gstIncluded: false, validityDays: 7 };

beforeAll(async () => {
  buyer = await party("buyer");
  seller = await party("seller");
  stranger = await party("stranger");
  listingId = addListing(seller.businessId).id;
  await upsertPriceBookEntry(seller, listingId, book);
});
afterAll(cleanup);
afterEach(() => { setQuoteProvidersForTests(null); vi.unstubAllEnvs(); });

const modelPrice = (pricePaise: number | null, over: Record<string, unknown> = {}): QuoteProviders => ({
  ...heuristicQuoteProviders,
  drafter: { draft: async () => ({ output: { pricePaise, quantity: 600, unit: "pcs", moq: 100, leadTimeDays: 7, shippingTerms: null, validityDays: 7, notes: "n", rationale: "r", ...over }, confidence: 0.9, provider: "test", modelId: "m", promptVersion: "p" }) },
});

describe("generateDraft", () => {
  it("drafts from the RFQ + price book, emits an event, logs the action, and is idempotent", async () => {
    const l = await acceptedLead(buyer, seller, { quantity: 600 });
    const d = (await generateDraft(seller.businessId, l.matchId))!;
    expect(d).toMatchObject({ status: "pending", pricePaise: 4800, quantity: 600, unit: "pcs", leadTimeDays: 7, quoteId: null, conversationId: l.conversationId });
    expect(d.boundsCheck).toMatchObject({ ok: true, floorPaise: 4200, modelPriceRejected: false });
    expect(d.notes).toContain("GST 18% extra");
    expect(d.validUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await events("QuoteDraftGenerated", l.matchId)).toHaveLength(1);
    expect((await events("QuoteDraftGenerated", l.matchId))[0]!.payload).toMatchObject({ draftId: d.id, matchId: l.matchId, sellerBusinessId: seller.businessId, pricePaise: 4800 });
    const dec = await prisma.aiDecision.findFirstOrThrow({ where: { subjectId: d.id } });
    expect(dec.capability).toBe("draft_quote");
    const log = await listAgentActions(seller.businessId, { subjectId: d.id });
    expect(log.map((x) => x.action)).toEqual(["draft_generated"]);
    expect(log[0]).toMatchObject({ byAssistant: true });
    expect(log[0]!.summary).toContain("Nothing was sent");
    // nothing reached the buyer
    expect((await getConversation(seller, l.conversationId!))!.quotes).toHaveLength(0);
    const again = await generateDraft(seller.businessId, l.matchId);
    expect(again!.id).toBe(d.id);
    expect(await prisma.quoteDraft.count({ where: { matchId: l.matchId } })).toBe(1);
    expect((await getDraftForMatch(seller.businessId, l.matchId))!.id).toBe(d.id);
    expect(await getDraftForMatch(stranger.businessId, l.matchId)).toBeNull();
    expect(await getDraftForMatch(seller.businessId, "nope")).toBeNull();
  });

  it("guards: unknown / foreign / not-yet-accepted leads, and no price book => no draft", async () => {
    await expect(generateDraft(seller.businessId, "nope")).rejects.toMatchObject({ code: "not_found" });
    const l = await acceptedLead(buyer, seller);
    await expect(generateDraft(stranger.businessId, l.matchId)).rejects.toMatchObject({ code: "not_found" });
    const offered = await acceptedLead(buyer, seller, { status: "offered" });
    await expect(generateDraft(seller.businessId, offered.matchId)).rejects.toMatchObject({ code: "conflict" });
    const noBook = await party("nobook");
    const l2 = await acceptedLead(buyer, noBook);
    expect(await generateDraft(noBook.businessId, l2.matchId)).toBeNull();
    expect((await listAgentActions(noBook.businessId))[0]).toMatchObject({ action: "draft_failed" });
    expect(await prisma.quoteDraft.count({ where: { matchId: l2.matchId } })).toBe(0);
  });

  it("REJECTS a model price below the seller's floor (or null) and uses the price book price instead", async () => {
    for (const bad of [1, 4199, null]) {
      setQuoteProvidersForTests(modelPrice(bad));
      const l = await acceptedLead(buyer, seller, { quantity: 600 });
      const d = (await generateDraft(seller.businessId, l.matchId))!;
      expect(d.pricePaise).toBeGreaterThanOrEqual(4200);
      expect(d.pricePaise).toBe(4800);
      expect(d.boundsCheck.modelPriceRejected).toBe(true);
      expect(d.needsReview).toBe(true);
      const actions = (await listAgentActions(seller.businessId, { enquiryId: l.enquiryId })).map((a) => a.action);
      expect(actions).toContain("draft_bounds_rejected");
    }
  });

  it("keeps a model price that is above the floor even if it differs from the tier, and lifts a too-short lead time", async () => {
    setQuoteProvidersForTests(modelPrice(4500, { leadTimeDays: 2, quantity: 50 }));
    const l = await acceptedLead(buyer, seller, { quantity: 600 });
    const d = (await generateDraft(seller.businessId, l.matchId))!;
    expect(d.pricePaise).toBe(4500);
    expect(d.leadTimeDays).toBe(7);
    expect(d.quantity).toBe(100); // never below the MOQ
    expect(d.boundsCheck.modelPriceRejected).toBe(true);
  });

  it("property: whatever price a model returns, the stored draft is never below the floor", async () => {
    await fc.assert(fc.asyncProperty(fc.oneof(fc.integer({ min: -1000, max: 20_000 }), fc.constant(null), fc.constant(0)), async (p) => {
      setQuoteProvidersForTests(modelPrice(p as number | null));
      const l = await acceptedLead(buyer, seller, { quantity: 600 });
      const d = (await generateDraft(seller.businessId, l.matchId))!;
      expect(d.pricePaise).toBeGreaterThanOrEqual(4200);
      expect(Number.isInteger(d.pricePaise)).toBe(true);
    }), { numRuns: 15 });
  });
});

describe("requestDraft", () => {
  it("needs the feature flag", async () => {
    const l = await acceptedLead(buyer, seller);
    await expect(requestDraft(seller, l.matchId)).rejects.toMatchObject({ code: "conflict" });
    vi.stubEnv("QUOTE_ASSIST_ENABLED", "true");
    expect((await requestDraft(seller, l.matchId))?.status).toBe("pending");
  });
});

describe("approve / discard (the only way a draft becomes a quote)", () => {
  const draft = async (over: Parameters<typeof acceptedLead>[2] = {}) => {
    const l = await acceptedLead(buyer, seller, over);
    await prisma.leadQuoteTiming.create({ data: { matchId: l.matchId, conversationId: l.conversationId!, sellerBusinessId: seller.businessId, acceptedAt: new Date() } });
    return { l, d: (await generateDraft(seller.businessId, l.matchId))! };
  };
  const quotes = async (convId: string) => (await getConversation(seller, convId))!.quotes;

  it("approving unedited sends exactly the drafted quote as the seller, emits QuoteDraftApproved, marks timing assisted, logs it", async () => {
    const { l, d } = await draft();
    const v = await approveDraft(seller, d.id);
    expect(v).toMatchObject({ status: "approved", edited: false });
    expect(v.quoteId).toBeTruthy();
    const q = await quotes(l.conversationId!);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ id: v.quoteId, pricePaise: 4800, quantity: 600, unit: "pcs", leadTimeDays: 7 });
    expect(q[0]!.notes).toContain("GST 18% extra");
    expect((await events("QuoteDraftApproved", l.matchId))[0]!.payload).toMatchObject({ draftId: d.id, quoteId: v.quoteId, edited: false, sellerBusinessId: seller.businessId });
    expect((await prisma.leadQuoteTiming.findUniqueOrThrow({ where: { matchId: l.matchId } })).assisted).toBe(true);
    const row = await prisma.quoteDraft.findUniqueOrThrow({ where: { id: d.id } });
    expect(row).toMatchObject({ decidedVia: "app", decidedByPersonId: seller.personId, editedFields: 0 });
    const log = (await listAgentActions(seller.businessId, { subjectId: d.id })).find((a) => a.action === "draft_approved")!;
    expect(log.byAssistant).toBe(false);
    // double approval (double tap / retry) never sends a second quote
    const again = await approveDraft(seller, d.id);
    expect(again.quoteId).toBe(v.quoteId);
    expect(await quotes(l.conversationId!)).toHaveLength(1);
    await expect(discardDraft(seller, d.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("edits are applied, flagged, and measured", async () => {
    const { l, d } = await draft();
    const v = await approveDraft(seller, d.id, { pricePaise: 4500, leadTimeDays: 5, notes: "GST extra. Freight extra.", validUntil: "2026-12-31" });
    expect(v).toMatchObject({ edited: true, pricePaise: 4500, leadTimeDays: 5 });
    const q = (await quotes(l.conversationId!))[0]!;
    expect(q).toMatchObject({ pricePaise: 4500, leadTimeDays: 5, validUntil: "2026-12-31" });
    const row = await prisma.quoteDraft.findUniqueOrThrow({ where: { id: d.id } });
    expect(row.editedFields).toBe(4);
    expect(row.priceDeltaPct).toBeCloseTo(-6.25, 1);
    expect(row.notesEditDistance).toBeGreaterThan(0);
    expect((await events("QuoteDraftApproved", l.matchId))[0]!.payload.edited).toBe(true);
  });

  it("enforces the floor server-side on approval: an edit below it is refused and nothing is sent", async () => {
    const { l, d } = await draft();
    await expect(approveDraft(seller, d.id, { pricePaise: 4199 })).rejects.toMatchObject({ code: "validation" });
    await expect(approveDraft(seller, d.id, { pricePaise: -1 })).rejects.toMatchObject({ code: "validation" });
    await expect(approveDraft(seller, d.id, { quantity: 0 })).rejects.toMatchObject({ code: "validation" });
    expect((await prisma.quoteDraft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("pending");
    expect(await quotes(l.conversationId!)).toHaveLength(0);
    // raising the floor after drafting also blocks an unedited approval
    await upsertPriceBookEntry(seller, listingId, { ...book, floorPricePaise: 4700 });
    await expect(approveDraft(seller, d.id, { pricePaise: 4600 })).rejects.toMatchObject({ code: "validation" });
    expect((await approveDraft(seller, d.id, { pricePaise: 4700 })).status).toBe("approved");
    await upsertPriceBookEntry(seller, listingId, book);
  });

  it("only the drafting business may act; malformed ids are not found", async () => {
    const { d } = await draft();
    await expect(approveDraft(stranger, d.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(discardDraft(stranger, d.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(approveDraft(seller, "nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("a failed send rolls the draft back to pending so the seller can retry", async () => {
    const { l, d } = await draft();
    await prisma.match.update({ where: { id: l.matchId }, data: { status: "refunded" } });
    await expect(approveDraft(seller, d.id)).rejects.toMatchObject({ code: "conflict" });
    const row = await prisma.quoteDraft.findUniqueOrThrow({ where: { id: d.id } });
    expect(row).toMatchObject({ status: "pending", decidedAt: null, quoteId: null });
    await prisma.match.update({ where: { id: l.matchId }, data: { status: "accepted" } });
    expect((await approveDraft(seller, d.id)).status).toBe("approved");
  });

  it("discard drops the draft, sends nothing, logs it, and cannot be approved later", async () => {
    const { l, d } = await draft();
    const v = await discardDraft(seller, d.id);
    expect(v.status).toBe("discarded");
    expect((await discardDraft(seller, d.id)).status).toBe("discarded");
    await expect(approveDraft(seller, d.id)).rejects.toMatchObject({ code: "conflict" });
    expect(await quotes(l.conversationId!)).toHaveLength(0);
    expect((await listAgentActions(seller.businessId, { subjectId: d.id })).map((a) => a.action)).toContain("draft_discarded");
  });

  it("two simultaneous approvals send exactly one quote", async () => {
    const { l, d } = await draft();
    const r = await Promise.allSettled([approveDraft(seller, d.id), approveDraft(seller, d.id)]);
    expect(r.some((x) => x.status === "fulfilled")).toBe(true);
    expect(await quotes(l.conversationId!)).toHaveLength(1);
  });
});

describe("approveDraftFromChannel (WhatsApp hook)", () => {
  it("rejects people outside the business and unknown drafts", async () => {
    const l = await acceptedLead(buyer, seller);
    const d = (await generateDraft(seller.businessId, l.matchId))!;
    await expect(approveDraftFromChannel(d.id, stranger.personId, "approve")).rejects.toMatchObject({ code: "forbidden" });
    await expect(approveDraftFromChannel(d.id, "nope", "approve")).rejects.toMatchObject({ code: "forbidden" });
    await expect(approveDraftFromChannel("nope", seller.personId, "approve")).rejects.toMatchObject({ code: "not_found" });
    expect((await prisma.quoteDraft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("pending");
  });
  it("approve sends the draft as drafted (via whatsapp); discard drops it", async () => {
    const l = await acceptedLead(buyer, seller);
    const d = (await generateDraft(seller.businessId, l.matchId))!;
    const r = await approveDraftFromChannel(d.id, seller.personId, "approve");
    expect(r).toMatchObject({ status: "approved" });
    expect(r.quoteId).toBeTruthy();
    expect((await prisma.quoteDraft.findUniqueOrThrow({ where: { id: d.id } })).decidedVia).toBe("whatsapp");
    const l2 = await acceptedLead(buyer, seller);
    const d2 = (await generateDraft(seller.businessId, l2.matchId))!;
    expect(await approveDraftFromChannel(d2.id, seller.personId, "discard")).toEqual({ status: "discarded", quoteId: null });
    expect((await getConversation(seller, l2.conversationId!))!.quotes).toHaveLength(0);
  });
});
