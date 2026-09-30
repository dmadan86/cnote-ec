import { heuristicQuoteProviders, setQuoteProvidersForTests, type QuoteProviders } from "@cnote/ai";
import { prisma } from "@cnote/db";
import { getConversation } from "@cnote/enquiry";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, events, party, world, type Party } from "./helpers";

import {
  compareQuotes, composeCounterMessage, discardCounterOffer, getBuyerBounds, getCounterProposal, listAgentActions, proposeCounterOffer, sendCounterOffer, setBuyerBounds,
} from "../src";

let buyer: Party, other: Party;
const sellers: Party[] = [];
let enquiryId: string;
const conv: string[] = [];
const quoteIds: string[] = [];
const quoteNotes = ["Free delivery. GST inclusive.", "Freight Rs 3,000 extra. GST @ 18% extra.", null];

beforeAll(async () => {
  vi.stubEnv("QUOTE_ASSIST_ENABLED", "true");
  buyer = await party("buyer");
  other = await party("other-buyer");
  sellers.push(await party("s0", { tier: 3 }), await party("s1", { tier: 1 }), await party("s2", { tier: 0 }));
  const e = await prisma.enquiry.create({
    data: { buyerBusinessId: buyer.businessId, buyerPersonId: buyer.personId, title: "Boxes", requirement: "Need 3 ply boxes for shipping", quantity: 100, quantityUnit: "pcs", targetPricePaise: 4500n, status: "matched" },
  });
  enquiryId = e.id;
  world.enquiryIds.push(e.id);
  const prices = [5000, 4600, 4400];
  const leads = [10, 7, 21];
  for (let i = 0; i < 3; i++) {
    const m = await prisma.match.create({ data: { enquiryId, sellerBusinessId: sellers[i]!.businessId, rank: i + 1, matchScore: 0.9, status: "accepted", respondBy: new Date(Date.now() + 3_600_000), respondedAt: new Date() } });
    const c = await prisma.conversation.create({ data: { matchId: m.id } });
    conv.push(c.id);
    if (i === 1) await prisma.quote.create({ data: { conversationId: c.id, sellerBusinessId: sellers[i]!.businessId, pricePaise: 9999n, quantity: 100, unit: "pcs", createdAt: new Date(Date.now() - 60_000) } });
    const q = await prisma.quote.create({ data: { conversationId: c.id, sellerBusinessId: sellers[i]!.businessId, pricePaise: BigInt(prices[i]!), quantity: 100, unit: "pcs", leadTimeDays: leads[i]!, notes: quoteNotes[i], validUntil: new Date("2099-01-01") } });
    quoteIds.push(q.id);
  }
});
afterAll(cleanup);
afterEach(() => { setQuoteProvidersForTests(null); });

const counterModel = (pricePaise: number, over: Record<string, unknown> = {}): QuoteProviders => ({
  ...heuristicQuoteProviders,
  countering: { propose: async () => ({ output: { pricePaise, leadTimeDays: null, note: "please review", rationale: "why", ...over }, confidence: 0.9, provider: "test", modelId: "m", promptVersion: "p" }) },
});

describe("buyer bounds", () => {
  it("defaults the target from the RFQ, validates, persists, and belongs to the buyer", async () => {
    expect(await getBuyerBounds(buyer, enquiryId)).toEqual({ enquiryId, targetPricePaise: 4500, ceilingPricePaise: null, maxLeadTimeDays: null });
    await expect(setBuyerBounds(buyer, enquiryId, { targetPricePaise: 5000, ceilingPricePaise: 4000, maxLeadTimeDays: null })).rejects.toMatchObject({ code: "validation" });
    await expect(setBuyerBounds(buyer, enquiryId, { targetPricePaise: -1, ceilingPricePaise: null, maxLeadTimeDays: null })).rejects.toMatchObject({ code: "validation" });
    await expect(setBuyerBounds(buyer, enquiryId, { targetPricePaise: null, ceilingPricePaise: null, maxLeadTimeDays: 0 })).rejects.toMatchObject({ code: "validation" });
    await expect(setBuyerBounds(other, enquiryId, { targetPricePaise: 1, ceilingPricePaise: null, maxLeadTimeDays: null })).rejects.toMatchObject({ code: "not_found" });
    await expect(getBuyerBounds(other, enquiryId)).rejects.toMatchObject({ code: "not_found" });
    await expect(getBuyerBounds(buyer, "nope")).rejects.toMatchObject({ code: "not_found" });
    await setBuyerBounds(buyer, enquiryId, { targetPricePaise: 4500, ceilingPricePaise: 4800, maxLeadTimeDays: 14 });
    expect(await getBuyerBounds(buyer, enquiryId)).toEqual({ enquiryId, targetPricePaise: 4500, ceilingPricePaise: 4800, maxLeadTimeDays: 14 });
    // clearing the target sticks (does not fall back to the RFQ value once the buyer has set bounds)
    await setBuyerBounds(buyer, enquiryId, { targetPricePaise: null, ceilingPricePaise: 4800, maxLeadTimeDays: 14 });
    expect((await getBuyerBounds(buyer, enquiryId)).targetPricePaise).toBeNull();
    await setBuyerBounds(buyer, enquiryId, { targetPricePaise: 4500, ceilingPricePaise: 4800, maxLeadTimeDays: 14 });
  });
});

describe("compareQuotes", () => {
  it("needs the feature flag", async () => {
    vi.stubEnv("QUOTE_ASSIST_ENABLED", "false");
    await expect(compareQuotes(buyer, enquiryId)).rejects.toMatchObject({ code: "conflict" });
    vi.stubEnv("QUOTE_ASSIST_ENABLED", "true");
  });

  it("only the enquiry's buyer can compare", async () => {
    await expect(compareQuotes(other, enquiryId)).rejects.toMatchObject({ code: "not_found" });
  });

  it("normalises the LATEST quote per seller into landed price, highlights winners with text badges, and reads terms only once", async () => {
    const c = await compareQuotes(buyer, enquiryId);
    expect(c.rows).toHaveLength(3);
    const byQuote = new Map(c.rows.map((r) => [r.quoteId, r]));
    const r0 = byQuote.get(quoteIds[0]!)!, r1 = byQuote.get(quoteIds[1]!)!, r2 = byQuote.get(quoteIds[2]!)!;
    expect(r0).toMatchObject({ landedPaise: 5000, landedComplete: true, deliveryIncluded: true, gstIncluded: true, verificationTier: 3, earlierQuotes: 0 });
    expect(r1).toMatchObject({ deliveryChargePaise: 300000, gstPercent: 18, gstIncluded: false, pricePaise: 4600, earlierQuotes: 1 });
    expect(r1.landedPaise).toBe(Math.round((4600 + 3000) * 1.18));
    expect(r2).toMatchObject({ landedComplete: false, assumptions: ["delivery_unknown", "gst_unknown"], landedPaise: 4400 });
    expect(c.rows.map((r) => r.landedPaise)).toEqual([...c.rows.map((r) => r.landedPaise)].sort((a, b) => a - b));
    expect(byQuote.get(quoteIds[2]!)!.badges).toContain("best_price");
    expect(byQuote.get(quoteIds[1]!)!.badges).toContain("fastest");
    expect(c.bestValueQuoteId).toBeTruthy();
    expect(c.rows.find((r) => r.quoteId === c.bestValueQuoteId)!.badges).toContain("best_value");
    expect(c.bounds.ceilingPricePaise).toBe(4800);

    const decisions = await prisma.aiDecision.count({ where: { subjectId: enquiryId, capability: "normalise_quotes" } });
    expect(decisions).toBe(1);
    await compareQuotes(buyer, enquiryId);
    expect(await prisma.aiDecision.count({ where: { subjectId: enquiryId, capability: "normalise_quotes" } })).toBe(decisions);
    const log = (await listAgentActions(buyer.businessId, { enquiryId })).filter((a) => a.action === "quotes_normalised");
    expect(log).toHaveLength(1);
    expect(log[0]!.summary).toContain("Nothing was sent");
  });

  it("marks expired quotes and never crowns them", async () => {
    const q = await prisma.quote.create({ data: { conversationId: conv[2]!, sellerBusinessId: sellers[2]!.businessId, pricePaise: 100n, quantity: 100, unit: "pcs", leadTimeDays: 1, validUntil: new Date("2020-01-01") } });
    const c = await compareQuotes(buyer, enquiryId);
    const row = c.rows.find((r) => r.quoteId === q.id)!;
    expect(row.expired).toBe(true);
    expect(row.badges).toEqual([]);
    expect(c.bestValueQuoteId).not.toBe(q.id);
    await prisma.quoteTerms.deleteMany({ where: { quoteId: q.id } });
    await prisma.quote.delete({ where: { id: q.id } });
    await prisma.quoteTerms.deleteMany({ where: { quoteId: q.id } });
  });
});

describe("counter offers", () => {
  const messages = async (i: number) => (await getConversation({ personId: buyer.personId, businessId: buyer.businessId }, conv[i]!))!.messages;

  it("refuses when no bounds are set, or the quote is already within target", async () => {
    const e2 = await prisma.enquiry.create({ data: { buyerBusinessId: buyer.businessId, buyerPersonId: buyer.personId, title: "NB", requirement: "no bounds enquiry text", quantity: 10, quantityUnit: "pcs", status: "matched" } });
    world.enquiryIds.push(e2.id);
    const m = await prisma.match.create({ data: { enquiryId: e2.id, sellerBusinessId: sellers[0]!.businessId, rank: 1, matchScore: 1, status: "accepted", respondBy: new Date(Date.now() + 1000), respondedAt: new Date() } });
    const c = await prisma.conversation.create({ data: { matchId: m.id } });
    const q = await prisma.quote.create({ data: { conversationId: c.id, sellerBusinessId: sellers[0]!.businessId, pricePaise: 1000n, quantity: 10, unit: "pcs" } });
    await expect(proposeCounterOffer(buyer, e2.id, q.id)).rejects.toMatchObject({ code: "validation" });
    await expect(proposeCounterOffer(buyer, enquiryId, quoteIds[2]!)).rejects.toMatchObject({ code: "conflict" }); // 4400 <= target 4500
    await expect(proposeCounterOffer(buyer, enquiryId, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "not_found" });
  });

  it("proposes within bounds, sends NOTHING, and logs it; a re-proposal supersedes the old one", async () => {
    const before = (await messages(0)).length;
    const p = await proposeCounterOffer(buyer, enquiryId, quoteIds[0]!);
    expect(p).toMatchObject({ status: "proposed", quotedPricePaise: 5000, pricePaise: 4500 });
    expect(p.pricePaise).toBeLessThanOrEqual(4800);
    expect(p.note).not.toMatch(/\d/);
    expect((await messages(0)).length).toBe(before);
    expect(await events("CounterOfferProposed", enquiryId)).toHaveLength(0);
    const log = (await listAgentActions(buyer.businessId, { subjectId: p.id }))[0]!;
    expect(log).toMatchObject({ action: "counter_proposed", byAssistant: true });
    const p2 = await proposeCounterOffer(buyer, enquiryId, quoteIds[0]!);
    expect((await getCounterProposal(buyer, p.id))!.status).toBe("discarded");
    expect((await getCounterProposal(buyer, p2.id))!.status).toBe("proposed");
    expect(await getCounterProposal(other, p2.id)).toBeNull();
    expect((await compareQuotes(buyer, enquiryId)).rows.find((r) => r.quoteId === quoteIds[0])!.counter?.id).toBe(p2.id);
    await discardCounterOffer(buyer, p2.id);
  });

  it("REJECTS a model counter above the buyer's ceiling and proposes the nearest allowed one instead", async () => {
    setQuoteProvidersForTests(counterModel(4990)); // above ceiling 4800, below quote 5000
    const p = await proposeCounterOffer(buyer, enquiryId, quoteIds[0]!);
    expect(p.pricePaise).toBeLessThanOrEqual(4800);
    expect(p.pricePaise).toBe(4500);
    expect(p.rationale).toContain("outside your limits");
    const actions = (await listAgentActions(buyer.businessId, { enquiryId })).map((a) => a.action);
    expect(actions).toContain("counter_bounds_rejected");
    await discardCounterOffer(buyer, p.id);
  });

  it.each([["at or above the quote", 5000], ["a lowball", 100], ["negative", -5]])("REJECTS a model counter that is %s", async (_n, price) => {
    setQuoteProvidersForTests(counterModel(price));
    const p = await proposeCounterOffer(buyer, enquiryId, quoteIds[0]!);
    expect(p.pricePaise).toBeLessThan(5000);
    expect(p.pricePaise).toBeGreaterThanOrEqual(2500);
    await discardCounterOffer(buyer, p.id);
  });

  it("REJECTS a model lead-time ask beyond the buyer's limit", async () => {
    setQuoteProvidersForTests(counterModel(4600, { leadTimeDays: 60 }));
    const p = await proposeCounterOffer(buyer, enquiryId, quoteIds[0]!);
    expect(p.leadTimeDays === null || p.leadTimeDays <= 14).toBe(true);
    await discardCounterOffer(buyer, p.id);
  });

  it("gives up cleanly when the buyer's limits leave no valid counter", async () => {
    await setBuyerBounds(buyer, enquiryId, { targetPricePaise: null, ceilingPricePaise: 1000, maxLeadTimeDays: null });
    await expect(proposeCounterOffer(buyer, enquiryId, quoteIds[0]!)).rejects.toMatchObject({ code: "conflict" });
    expect((await listAgentActions(buyer.businessId, { enquiryId, limit: 5 })).some((a) => a.action === "counter_bounds_rejected")).toBe(true);
    await setBuyerBounds(buyer, enquiryId, { targetPricePaise: 4500, ceilingPricePaise: 4800, maxLeadTimeDays: 14 });
  });

  it("sends only when the buyer sends: message + event + log; idempotent; edits are re-checked against bounds", async () => {
    const p = await proposeCounterOffer(buyer, enquiryId, quoteIds[0]!);
    await expect(sendCounterOffer(buyer, p.id, { pricePaise: 4900 })).rejects.toMatchObject({ code: "validation" }); // above ceiling
    await expect(sendCounterOffer(buyer, p.id, { pricePaise: 5000 })).rejects.toMatchObject({ code: "validation" }); // not a counter
    await expect(sendCounterOffer(buyer, p.id, { pricePaise: 100 })).rejects.toMatchObject({ code: "validation" }); // lowball
    await expect(sendCounterOffer(buyer, p.id, { leadTimeDays: 30 })).rejects.toMatchObject({ code: "validation" });
    await expect(sendCounterOffer(other, p.id)).rejects.toMatchObject({ code: "not_found" });
    expect((await messages(0)).filter((m) => m.body.includes("Counter-offer")).length).toBe(0);

    const sent = await sendCounterOffer(buyer, p.id, { pricePaise: 4550, note: "Can you do better on the rate?", leadTimeDays: 10 });
    expect(sent).toMatchObject({ status: "sent", pricePaise: 4550, edited: true, leadTimeDays: 10 });
    const msg = (await messages(0)).find((m) => m.body.includes("Counter-offer"))!;
    expect(msg.senderPersonId).toBe(buyer.personId);
    expect(msg.body).toContain("Can you do better on the rate?");
    expect(msg.body).toContain("Rs 45.50 per pcs");
    expect(msg.body).toContain("your quote: Rs 50");
    expect(msg.body).toContain("within 10 days");
    expect((await events("CounterOfferProposed", enquiryId))[0]!.payload).toMatchObject({ proposalId: p.id, enquiryId, quoteId: quoteIds[0], buyerBusinessId: buyer.businessId, pricePaise: 4550 });
    const log = (await listAgentActions(buyer.businessId, { subjectId: p.id })).find((a) => a.action === "counter_sent")!;
    expect(log.byAssistant).toBe(false);
    const again = await sendCounterOffer(buyer, p.id);
    expect(again.status).toBe("sent");
    expect((await messages(0)).filter((m) => m.body.includes("Counter-offer")).length).toBe(1);
    await expect(discardCounterOffer(buyer, p.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("unedited send is flagged unedited; bounds tightened after proposing block the send", async () => {
    const p = await proposeCounterOffer(buyer, enquiryId, quoteIds[1]!); // quote 4600
    expect(p.pricePaise).toBeLessThan(4600);
    await setBuyerBounds(buyer, enquiryId, { targetPricePaise: null, ceilingPricePaise: p.pricePaise - 1, maxLeadTimeDays: 14 });
    await expect(sendCounterOffer(buyer, p.id)).rejects.toMatchObject({ code: "validation" });
    expect((await getCounterProposal(buyer, p.id))!.status).toBe("proposed");
    await setBuyerBounds(buyer, enquiryId, { targetPricePaise: 4500, ceilingPricePaise: 4800, maxLeadTimeDays: 14 });
    const sent = await sendCounterOffer(buyer, p.id);
    expect(sent.edited).toBe(false);
  });

  it("discard sends nothing and blocks a later send; a failed message rolls the claim back", async () => {
    const p = await proposeCounterOffer(buyer, enquiryId, quoteIds[0]!);
    await discardCounterOffer(buyer, p.id);
    await discardCounterOffer(buyer, p.id);
    await expect(sendCounterOffer(buyer, p.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(sendCounterOffer(buyer, "nope")).rejects.toMatchObject({ code: "not_found" });
    await expect(sendCounterOffer(buyer, p.id, { pricePaise: -1 })).rejects.toBeTruthy();

    const p2 = await proposeCounterOffer(buyer, enquiryId, quoteIds[0]!);
    const m = await prisma.match.findFirstOrThrow({ where: { conversation: { id: conv[0]! } } });
    await prisma.match.update({ where: { id: m.id }, data: { status: "refunded" } });
    await expect(sendCounterOffer(buyer, p2.id)).rejects.toMatchObject({ code: "conflict" });
    expect((await getCounterProposal(buyer, p2.id))!.status).toBe("proposed");
    await prisma.match.update({ where: { id: m.id }, data: { status: "accepted" } });
    await discardCounterOffer(buyer, p2.id);
  });
});

describe("composeCounterMessage", () => {
  it("builds the figures server-side so an edited note can never disagree with the price", () => {
    expect(composeCounterMessage({ note: "  Hello  ", quotedPricePaise: 5000, pricePaise: 4550, unit: "pcs", leadTimeDays: null })).toBe("Hello\n\nCounter-offer: Rs 45.50 per pcs (your quote: Rs 50).");
    expect(composeCounterMessage({ note: "", quotedPricePaise: 10000, pricePaise: 9000, unit: "kg", leadTimeDays: 5 })).toBe("Counter-offer: Rs 90 per kg (your quote: Rs 100), delivery within 5 days.");
  });
});
