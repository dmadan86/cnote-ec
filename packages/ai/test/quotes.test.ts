import { prisma } from "@cnote/db";
import * as fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anthropicQuoteProviders, draftQuote, draftQuoteHeuristic, getQuoteProviders, heuristicQuoteProviders, normaliseQuotes, normaliseQuotesHeuristic,
  proposeCounter, proposeCounterHeuristic, setQuoteProvidersForTests, tierPriceFor, QUOTE_REVIEW_THRESHOLDS,
  type DraftQuoteInput, type ProposeCounterInput,
} from "../src";
import type { MessagesClient } from "../src/anthropic";

const fake = (impl: (p: any) => unknown): MessagesClient => ({ messages: { create: async (p: any) => impl(p) } }) as unknown as MessagesClient;
const text = (obj: unknown) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(obj) }] });

const pb = { basePricePaise: 5000, unit: "pcs", tiers: [{ minQty: 500, pricePaise: 4800 }, { minQty: 1000, pricePaise: 4500 }], floorPricePaise: 4200, moq: 100, leadTimeDays: 7, deliveryTerms: "Freight extra", gstPercent: 18, gstIncluded: false, validityDays: 7 };
const draftIn = (over: Partial<DraftQuoteInput["rfq"]> = {}, book: DraftQuoteInput["priceBook"] = pb): DraftQuoteInput => ({
  rfq: { title: "Corrugated boxes", requirement: "3 ply boxes", quantity: 600, unit: "pcs", targetPricePaise: null, neededBy: null, deliveryCity: "Pune", deliveryPincode: "411001", ...over },
  priceBook: book, history: { quotesSent: 0, recent: [] }, today: "2026-10-01",
});

afterEach(() => { vi.restoreAllMocks(); setQuoteProvidersForTests(null); delete process.env.AI_PROVIDER; });

describe("tierPriceFor", () => {
  it("picks the highest tier not above the quantity", () => {
    expect(tierPriceFor(5000, pb.tiers, 50)).toBe(5000);
    expect(tierPriceFor(5000, pb.tiers, 500)).toBe(4800);
    expect(tierPriceFor(5000, pb.tiers, 5000)).toBe(4500);
    expect(tierPriceFor(5000, [{ minQty: 10, pricePaise: 4000 }, { minQty: 5, pricePaise: 4500 }], 12)).toBe(4000);
  });
});

describe("draftQuoteHeuristic", () => {
  it("uses the tier price and states GST/freight/validity", () => {
    const r = draftQuoteHeuristic(draftIn());
    expect(r.output.pricePaise).toBe(4800);
    expect(r.output.quantity).toBe(600);
    expect(r.output.notes).toContain("GST 18% extra");
    expect(r.output.notes).toContain("Delivery to Pune");
    expect(r.confidence).toBeGreaterThan(0.8);
  });
  it("meets a target halfway when it is above the floor", () => {
    expect(draftQuoteHeuristic(draftIn({ targetPricePaise: 4400 })).output.pricePaise).toBe(4600);
  });
  it("holds the tier price when the target is below the floor, with lower confidence", () => {
    const r = draftQuoteHeuristic(draftIn({ targetPricePaise: 3000 }));
    expect(r.output.pricePaise).toBe(4800);
    expect(r.output.rationale).toContain("below your floor");
    expect(r.confidence).toBeLessThan(0.8);
  });
  it("never moves above the tier price when the target is higher", () => {
    expect(draftQuoteHeuristic(draftIn({ targetPricePaise: 9000 })).output.pricePaise).toBe(4800);
  });
  it("quotes the MOQ when the ask is below it, and flags unit mismatch, missing quantity, tight deadline", () => {
    const low = draftQuoteHeuristic(draftIn({ quantity: 20 }));
    expect(low.output.quantity).toBe(100);
    expect(low.output.rationale).toContain("below your MOQ");
    expect(draftQuoteHeuristic(draftIn({ unit: "kg" })).output.rationale).toContain("per pcs");
    const none = draftQuoteHeuristic(draftIn({ quantity: null }));
    expect(none.output.quantity).toBe(100);
    expect(none.confidence).toBeLessThan(0.75);
    const rush = draftQuoteHeuristic(draftIn({ neededBy: "2026-10-03" }));
    expect(rush.output.rationale).toContain("needs it in 2 days");
    expect(rush.confidence).toBeLessThan(0.7);
    expect(draftQuoteHeuristic(draftIn({ neededBy: "2026-09-01" })).output.rationale).toContain("in 0 days");
  });
  it("handles a price book without GST/terms, and history bonus", () => {
    const book = { ...pb, gstPercent: null, deliveryTerms: null, moq: null, gstIncluded: true };
    const r = draftQuoteHeuristic({ ...draftIn({ deliveryCity: null }, book), history: { quotesSent: 5, recent: [] } });
    expect(r.output.notes).toContain("GST as applicable");
    expect(r.output.notes).toContain("Freight extra, at actuals");
    expect(draftQuoteHeuristic(draftIn({}, { ...pb, gstIncluded: true })).output.notes).toContain("GST 18% included");
  });
  it("drafts no price without a price book", () => {
    const r = draftQuoteHeuristic(draftIn({ unit: null, quantity: null }, null));
    expect(r.output.pricePaise).toBeNull();
    expect(r.confidence).toBeLessThanOrEqual(0.2);
    expect(r.output.unit).toBe("pcs");
  });
  it("property: with a sane price book the price is never below the floor and never above the tier price", () => {
    fc.assert(fc.property(
      fc.integer({ min: 100, max: 1_000_000 }), fc.integer({ min: 1, max: 100 }), fc.integer({ min: 1, max: 100_000 }),
      fc.option(fc.integer({ min: 1, max: 2_000_000 }), { nil: null }),
      (base, floorPct, qty, target) => {
        const floor = Math.max(1, Math.floor((base * floorPct) / 100));
        const book = { ...pb, basePricePaise: base, floorPricePaise: floor, tiers: [{ minQty: 1000, pricePaise: Math.max(floor, Math.floor(base * 0.9)) }], moq: null };
        const r = draftQuoteHeuristic(draftIn({ quantity: qty, targetPricePaise: target }, book));
        const tier = tierPriceFor(base, book.tiers, qty);
        expect(r.output.pricePaise).toBeGreaterThanOrEqual(floor);
        expect(r.output.pricePaise).toBeLessThanOrEqual(tier);
        expect(Number.isInteger(r.output.pricePaise)).toBe(true);
      },
    ));
  });
});

describe("normaliseQuotesHeuristic", () => {
  const q = (notes: string | null, id = "q1") => ({ quoteId: id, pricePaise: 1000, quantity: 10, unit: "pcs", notes });
  const one = (notes: string | null) => normaliseQuotesHeuristic({ quotes: [q(notes)] }).output.terms[0]!;
  it("reads free delivery and GST inclusive", () => {
    expect(one("Free delivery. Price inclusive of GST.")).toMatchObject({ deliveryIncluded: true, deliveryChargePaise: 0, gstIncluded: true });
    expect(one("delivered price, all-inclusive")).toMatchObject({ deliveryIncluded: true, gstIncluded: true });
  });
  it("reads a freight amount and GST percent extra", () => {
    expect(one("Freight Rs. 2,500 extra. GST @ 18% extra. 50% advance")).toMatchObject({ deliveryIncluded: false, deliveryChargePaise: 250000, gstPercent: 18, gstIncluded: false, paymentTerms: "50% advance" });
    expect(one("transport ₹1200, 12% GST")).toMatchObject({ deliveryChargePaise: 120000, gstPercent: 12 });
  });
  it("reads freight extra with no figure, ex-works, credit terms", () => {
    expect(one("Freight extra at actuals")).toMatchObject({ deliveryIncluded: false, deliveryChargePaise: null });
    expect(one("Ex-works Surat. Net 30")).toMatchObject({ deliveryIncluded: false, paymentTerms: "net 30" });
    expect(one("GST extra + freight to pay, COD").gstIncluded).toBe(false);
  });
  it("returns unknowns for empty notes with moderate confidence", () => {
    const r = normaliseQuotesHeuristic({ quotes: [q(null)] });
    expect(r.output.terms[0]).toMatchObject({ deliveryIncluded: null, gstIncluded: null, gstPercent: null, paymentTerms: null });
    expect(r.confidence).toBeCloseTo(0.55);
    expect(normaliseQuotesHeuristic({ quotes: [] }).confidence).toBeCloseTo(0.9);
  });
});

describe("proposeCounterHeuristic", () => {
  const base = (over: Partial<ProposeCounterInput> = {}): ProposeCounterInput => ({
    enquiryTitle: "Boxes", quote: { pricePaise: 5000, quantity: 500, unit: "pcs", leadTimeDays: 14 },
    bounds: { targetPricePaise: 4500, ceilingPricePaise: 4800, maxLeadTimeDays: 10 },
    peers: { count: 3, bestLandedPricePaise: 5200, thisLandedPricePaise: 5900 }, ...over,
  });
  it("aims for the target, asks for lead time within the limit, mentions cheaper peers, and puts no numbers in the note", () => {
    const r = proposeCounterHeuristic(base());
    expect(r.output.pricePaise).toBe(4500);
    expect(r.output.leadTimeDays).toBe(10);
    expect(r.output.note).toContain("lower delivered price");
    expect(r.output.note).not.toMatch(/\d/);
    expect(r.confidence).toBe(0.8);
  });
  it("without a target uses 5% off, capped by the ceiling and always below the quote", () => {
    const r = proposeCounterHeuristic(base({ bounds: { targetPricePaise: null, ceilingPricePaise: null, maxLeadTimeDays: null }, peers: { count: 1, bestLandedPricePaise: null, thisLandedPricePaise: null } }));
    expect(r.output.pricePaise).toBe(4750);
    expect(r.output.leadTimeDays).toBeNull();
    expect(r.output.note).not.toContain("other offers");
    expect(r.confidence).toBe(0.6);
    expect(proposeCounterHeuristic(base({ bounds: { targetPricePaise: 9000, ceilingPricePaise: null, maxLeadTimeDays: null } })).output.pricePaise).toBe(4999);
    expect(proposeCounterHeuristic(base({ bounds: { targetPricePaise: 4900, ceilingPricePaise: 4000, maxLeadTimeDays: null } })).output.pricePaise).toBe(4000);
  });
});

describe("anthropic providers", () => {
  const draftJson = { pricePaise: 4800.4, quantity: 600, unit: "pcs", moq: 100, leadTimeDays: 7.2, shippingTerms: null, validityDays: 7, notes: "GST extra", rationale: "tier", confidence: 1.4 };
  it("maps and clamps model output", async () => {
    const p = anthropicQuoteProviders(fake(() => text(draftJson)));
    const r = await p.drafter.draft(draftIn());
    expect(r.provider).toBe("anthropic");
    expect(r.output).toMatchObject({ pricePaise: 4800, leadTimeDays: 7 });
    expect(r.confidence).toBe(1);
    const n = await p.normaliser.normalise({ quotes: [{ quoteId: "a", pricePaise: 1, quantity: 1, unit: "pcs", notes: null }, { quoteId: "b", pricePaise: 1, quantity: 1, unit: "pcs", notes: null }] });
    // unknown ids dropped, uncovered ids filled with unknowns
    const nf = anthropicQuoteProviders(fake(() => text({ terms: [{ quoteId: "a", deliveryChargePaise: 99.6, deliveryIncluded: false, gstPercent: 17.6, gstIncluded: null, paymentTerms: null }, { quoteId: "zzz", deliveryChargePaise: null, deliveryIncluded: null, gstPercent: null, gstIncluded: null, paymentTerms: null }], confidence: 0.7 })));
    const r2 = await nf.normaliser.normalise({ quotes: [{ quoteId: "a", pricePaise: 1, quantity: 1, unit: "pcs", notes: "x" }, { quoteId: "b", pricePaise: 1, quantity: 1, unit: "pcs", notes: null }] });
    expect(r2.output.terms).toEqual([
      { quoteId: "a", deliveryChargePaise: 100, deliveryIncluded: false, gstPercent: 18, gstIncluded: null, paymentTerms: null },
      { quoteId: "b", deliveryChargePaise: null, deliveryIncluded: null, gstPercent: null, gstIncluded: null, paymentTerms: null },
    ]);
    expect(n.provider).toBe("heuristic-fallback");
    const c = await anthropicQuoteProviders(fake(() => text({ pricePaise: 4499.6, leadTimeDays: null, note: "hi", rationale: "r", confidence: 0.9 }))).countering.propose({
      enquiryTitle: "x", quote: { pricePaise: 5000, quantity: 1, unit: "pcs", leadTimeDays: null }, bounds: { targetPricePaise: null, ceilingPricePaise: null, maxLeadTimeDays: null }, peers: { count: 0, bestLandedPricePaise: null, thisLandedPricePaise: null },
    });
    expect(c.output.pricePaise).toBe(4500);
  });
  it.each([
    ["network error", () => { throw new Error("ECONNRESET"); }],
    ["refusal", () => ({ stop_reason: "refusal", content: [] })],
    ["no text", () => ({ stop_reason: "end_turn", content: [] })],
    ["schema mismatch", () => text({ wrong: 1 })],
  ])("falls back to heuristic on %s and can be disabled", async (_n, impl) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = anthropicQuoteProviders(fake(impl));
    const d = await p.drafter.draft(draftIn());
    expect(d).toMatchObject({ provider: "heuristic-fallback", modelId: "heuristic-v1" });
    expect(d.output.pricePaise).toBe(4800);
    expect((await p.countering.propose({ enquiryTitle: "x", quote: { pricePaise: 5000, quantity: 1, unit: "pcs", leadTimeDays: null }, bounds: { targetPricePaise: 4000, ceilingPricePaise: null, maxLeadTimeDays: null }, peers: { count: 0, bestLandedPricePaise: null, thisLandedPricePaise: null } })).provider).toBe("heuristic-fallback");
    await expect(anthropicQuoteProviders(fake(impl), false).drafter.draft(draftIn())).rejects.toThrow();
  });
  it("sends the redacted payload inside <user_input>", async () => {
    let seen: any;
    const p = anthropicQuoteProviders(fake((req) => { seen = req; return text(draftJson); }));
    await p.drafter.draft(draftIn({ requirement: "call me on 9876543210 or a@b.com" }));
    const body = seen.messages[0].content as string;
    expect(body).toContain("<user_input>");
    expect(body).not.toContain("9876543210");
    expect(body).not.toContain("a@b.com");
  });
});

describe("registry selection", () => {
  it("defaults to heuristic, switches on AI_PROVIDER, honours the test override", () => {
    expect(getQuoteProviders()).toBe(heuristicQuoteProviders);
    process.env.AI_PROVIDER = "anthropic";
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    expect(getQuoteProviders()).not.toBe(heuristicQuoteProviders);
    setQuoteProvidersForTests(heuristicQuoteProviders);
    expect(getQuoteProviders()).toBe(heuristicQuoteProviders);
    vi.unstubAllEnvs();
  });
});

describe("decision logging", () => {
  const subj = (type: "quote_draft" | "quote_comparison" | "counter_proposal") => ({ type, id: crypto.randomUUID() });
  it("draftQuote writes an AiDecision with redacted input and flags low confidence without enqueuing an ops review", async () => {
    const s = subj("quote_draft");
    const r = await draftQuote(draftIn({ requirement: "mail me a@b.com", quantity: null }), s);
    expect(r.needsReview).toBe(r.confidence < QUOTE_REVIEW_THRESHOLDS.draft_quote);
    const row = await prisma.aiDecision.findUniqueOrThrow({ where: { id: r.decisionId }, include: { reviews: true } });
    expect(row).toMatchObject({ capability: "draft_quote", subjectType: "quote_draft", subjectId: s.id, promptVersion: "draft-quote-heuristic-v1", modelId: "heuristic-v1" });
    expect(JSON.stringify(row.inputRedacted)).not.toContain("a@b.com");
    expect(row.reviews).toHaveLength(0);
  });
  it("flags needsReview for a no-price-book draft", async () => {
    const r = await draftQuote(draftIn({}, null), subj("quote_draft"));
    expect(r.needsReview).toBe(true);
  });
  it("normaliseQuotes redacts note PII in the audit row", async () => {
    const s = subj("quote_comparison");
    const r = await normaliseQuotes({ quotes: [{ quoteId: "q", pricePaise: 100, quantity: 1, unit: "pcs", notes: "Call 9876543210. Freight Rs 500" }] }, s);
    expect(r.terms[0]!.deliveryChargePaise).toBe(50000);
    const row = await prisma.aiDecision.findUniqueOrThrow({ where: { id: r.decisionId } });
    expect(JSON.stringify(row.inputRedacted)).not.toContain("9876543210");
    await expect(normaliseQuotes({ quotes: [] }, s)).resolves.toMatchObject({ terms: [] });
  });
  it("proposeCounter logs the decision", async () => {
    const s = subj("counter_proposal");
    const r = await proposeCounter({ enquiryTitle: "b", quote: { pricePaise: 5000, quantity: 1, unit: "pcs", leadTimeDays: null }, bounds: { targetPricePaise: 4500, ceilingPricePaise: null, maxLeadTimeDays: null }, peers: { count: 0, bestLandedPricePaise: null, thisLandedPricePaise: null } }, s);
    expect(r.pricePaise).toBe(4500);
    expect((await prisma.aiDecision.findUniqueOrThrow({ where: { id: r.decisionId } })).capability).toBe("propose_counter");
  });
});
