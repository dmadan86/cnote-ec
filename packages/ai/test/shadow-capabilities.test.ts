// ADR-008 shadow mode for the capabilities with their own provider ports: document, inspection, dispute brief, quotes.
import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  briefDispute, briefDisputeHeuristic, draftQuote, extractDocument, flushShadowDecisions, getShadowDisputeProvider, getShadowDispatchInspector,
  getShadowDocumentExtractor, getShadowQuoteProviders, heuristicDisputeProvider, heuristicQuoteProviders, inspectDispatch, inspectDispatchHeuristic,
  normaliseQuotes, proposeCounter, setShadowDisputeProviderForTests, setShadowDispatchInspectorForTests, setShadowDocumentExtractorForTests,
  setShadowQuoteProvidersForTests, summariseShadowPairs, type ShadowPair,
} from "../src";
import { syntheticPng } from "../evals/fixtures";

const runId = randomUUID();
const sid = (n: string) => `${runId}-${n}`;
const ENV = ["AI_PROVIDER", "AI_SHADOW_PROVIDER", "AI_SHADOW_MODEL_REASONING", "AI_SHADOW_MODEL_FAST"] as const;

afterEach(() => {
  setShadowDocumentExtractorForTests(null); setShadowDispatchInspectorForTests(null); setShadowDisputeProviderForTests(null); setShadowQuoteProvidersForTests(null);
  for (const k of ENV) delete process.env[k];
  vi.restoreAllMocks();
});
afterAll(async () => {
  await prisma.reviewItem.deleteMany({ where: { subjectId: { startsWith: runId } } });
  await prisma.aiDecision.deleteMany({ where: { subjectId: { startsWith: runId } } });
});

const png = () => syntheticPng(64, 48, "checker", [200, 30, 30]);
const shadowRow = (id: string) => prisma.aiDecision.findFirstOrThrow({ where: { subjectId: id, shadow: true }, include: { reviews: true } });

describe("candidate resolution", () => {
  it("is null when off or when it repeats the live provider and models; built when it differs", () => {
    expect(getShadowDocumentExtractor()).toBeNull();
    expect(getShadowDispatchInspector()).toBeNull();
    expect(getShadowDisputeProvider()).toBeNull();
    expect(getShadowQuoteProviders()).toBeNull();
    process.env.AI_SHADOW_PROVIDER = "heuristic";
    expect(getShadowDisputeProvider()).toBeNull(); // same as live heuristic
    process.env.AI_SHADOW_MODEL_REASONING = "claude-candidate";
    expect(getShadowDisputeProvider()).toBe(heuristicDisputeProvider);
    expect(getShadowQuoteProviders()).toBe(heuristicQuoteProviders);
    expect(getShadowDocumentExtractor()).not.toBeNull();
    expect(getShadowDispatchInspector()).not.toBeNull();
    process.env.AI_SHADOW_PROVIDER = "anthropic";
    const p = getShadowQuoteProviders();
    expect(p).not.toBeNull();
    expect(getShadowQuoteProviders()).toBe(p); // cached
    expect(getShadowDocumentExtractor()).not.toBeNull();
    expect(getShadowDispatchInspector()).not.toBeNull();
    expect(getShadowDisputeProvider()).not.toBeNull();
  });
});

describe("shadow rows for the extended capabilities", () => {
  it("extract_document: shadow row with the candidate's model, redacted, no review item, live answer untouched", async () => {
    setShadowDocumentExtractorForTests({
      extract: async () => ({ output: { fields: { pan: "ABCDE1234F", name: "Sharma Steel" }, forgerySignals: ["font mismatch"] }, confidence: 0.2, provider: "anthropic", modelId: "claude-candidate", promptVersion: "extract-document-v2" }),
    });
    const live = await extractDocument({ image: { bytes: png(), mimeType: "image/png" }, docType: "pan_card" }, { type: "business", id: sid("doc") });
    expect(live.fields).toEqual({});
    await flushShadowDecisions();
    const s = await shadowRow(sid("doc"));
    expect(s).toMatchObject({ capability: "extract_document", shadowOfId: live.decisionId, modelId: "claude-candidate", promptVersion: "extract-document-v2" });
    expect(s.reviews).toHaveLength(0);
    expect(JSON.stringify(s.output)).not.toMatch(/ABCDE1234F|Sharma/);
    expect(JSON.stringify(s.inputRedacted)).not.toMatch(/iVBOR/);
  });

  it("inspect_dispatch: shadowed, never queued", async () => {
    setShadowDispatchInspectorForTests({ inspect: async (i) => ({ ...inspectDispatchHeuristic(i), modelId: "claude-candidate" }) });
    const live = await inspectDispatch({
      images: [{ bytes: png(), mimeType: "image/png", width: 64, height: 48 }], language: "en",
      expected: { categorySlug: "boxes", productTitle: "box", quantity: 10, unit: "piece", requirement: "x", attributes: {}, labelling: [] },
    }, { type: "business", id: sid("insp") });
    await flushShadowDecisions();
    const s = await shadowRow(sid("insp"));
    expect(s).toMatchObject({ capability: "inspect_dispatch", shadowOfId: live.decisionId, modelId: "claude-candidate" });
    expect(s.reviews).toHaveLength(0);
  });

  const disputeIn = {
    claimedType: "damaged" as const, claimedAmountPaise: 400_000, atStakePaise: 1_000_000,
    order: { totalPaise: 1_000_000, quantity: 100, unit: "box", pricePaise: 10_000, status: "delivered" },
    quote: { pricePaise: 10_000, quantity: 100, unit: "box", leadTimeDays: 5, notes: null },
    evidence: [], qualityChecks: [], counterpartyResponded: true,
  };

  it("dispute_brief: shadowed with the candidate output; a failing candidate becomes an error row", async () => {
    setShadowDisputeProviderForTests({ brief: async (i) => ({ ...briefDisputeHeuristic(i), modelId: "claude-candidate" }) });
    const live = await briefDispute(disputeIn, { type: "dispute", id: sid("dsp") });
    await flushShadowDecisions();
    expect(await shadowRow(sid("dsp"))).toMatchObject({ capability: "dispute_brief", shadowOfId: live.decisionId, modelId: "claude-candidate" });

    process.env.AI_SHADOW_PROVIDER = "anthropic";
    setShadowDisputeProviderForTests({ brief: async () => { throw new Error("candidate 529"); } });
    const live2 = await briefDispute(disputeIn, { type: "dispute", id: sid("dsp2") });
    await flushShadowDecisions();
    expect(live2.decisionId).toBeTruthy();
    expect((await shadowRow(sid("dsp2"))).output).toEqual({ shadowError: "candidate 529" });
  });

  it("draft_quote, normalise_quotes and propose_counter are shadowed", async () => {
    setShadowQuoteProvidersForTests({
      drafter: { draft: async (i) => ({ ...(await heuristicQuoteProviders.drafter.draft(i)), modelId: "claude-candidate" }) },
      normaliser: { normalise: async (i) => ({ ...(await heuristicQuoteProviders.normaliser.normalise(i)), modelId: "claude-candidate" }) },
      countering: { propose: async (i) => ({ ...(await heuristicQuoteProviders.countering.propose(i)), modelId: "claude-candidate" }) },
    });
    const d = await draftQuote({
      rfq: { title: "Boxes", requirement: "3 ply", quantity: 600, unit: "pcs", targetPricePaise: null, neededBy: null, deliveryCity: "Pune", deliveryPincode: "411001" },
      priceBook: { basePricePaise: 5000, unit: "pcs", tiers: [], floorPricePaise: 4200, moq: 100, leadTimeDays: 7, deliveryTerms: "x", gstPercent: 18, gstIncluded: false, validityDays: 7 },
      history: { quotesSent: 0, recent: [] }, today: "2026-10-01",
    }, { type: "quote_draft", id: sid("qd") });
    const n = await normaliseQuotes({ quotes: [{ quoteId: "q1", pricePaise: 100, quantity: 1, unit: "pcs", notes: "freight Rs 500" }] }, { type: "quote_comparison", id: sid("qn") });
    const c = await proposeCounter({
      enquiryTitle: "x", quote: { pricePaise: 5000, quantity: 1, unit: "pcs", leadTimeDays: null }, bounds: { targetPricePaise: 4500, ceilingPricePaise: null, maxLeadTimeDays: null },
      peers: { count: 0, bestLandedPricePaise: null, thisLandedPricePaise: null },
    }, { type: "counter_proposal", id: sid("qc") });
    await flushShadowDecisions();
    for (const [name, cap, live] of [["qd", "draft_quote", d], ["qn", "normalise_quotes", n], ["qc", "propose_counter", c]] as const) {
      expect(await shadowRow(sid(name))).toMatchObject({ capability: cap, shadowOfId: live.decisionId, modelId: "claude-candidate" });
    }
  });

  it("does nothing when shadow mode is off", async () => {
    const live = await extractDocument({ image: { bytes: png(), mimeType: "image/png" }, docType: "pan_card" }, { type: "business", id: sid("off") });
    await flushShadowDecisions();
    expect(await prisma.aiDecision.count({ where: { subjectId: sid("off") } })).toBe(1);
    expect(live.decisionId).toBeTruthy();
  });
});

describe("shadow report agreement for the extended capabilities", () => {
  const side = (o: Record<string, unknown>, confidence = 0.9) => ({ modelId: "m", promptVersion: "p", confidence, latencyMs: 10, output: o });
  const pair = (capability: string, live: Record<string, unknown>, shadow: Record<string, unknown>): ShadowPair => ({ capability, live: side(live), shadow: side(shadow) });
  const get = (out: ReturnType<typeof summariseShadowPairs>, c: string) => out.find((x) => x.capability === c)!;

  it("scores agreement per capability", () => {
    const out = summariseShadowPairs([
      pair("extract_document", { fields: { pan: "[pan]" }, forgerySignals: [] }, { fields: { pan: "[pan]" }, forgerySignals: [] }),
      pair("extract_document", { fields: { pan: "[pan]" }, forgerySignals: [] }, { fields: { pan: "[pan]" }, forgerySignals: ["x"] }),
      pair("inspect_dispatch", { verdict: "consistent" }, { verdict: "inconsistent" }),
      pair("dispute_brief", { recommendation: { outcome: "split" } }, { recommendation: { outcome: "split" } }),
      pair("draft_quote", { pricePaise: 1000 }, { pricePaise: 1040 }),
      pair("draft_quote", { pricePaise: 1000 }, { pricePaise: 1200 }),
      pair("draft_quote", { pricePaise: null }, { pricePaise: null }),
      pair("draft_quote", { pricePaise: 0 }, { pricePaise: 0 }),
      pair("draft_quote", { pricePaise: 10 }, { pricePaise: null }),
      pair("propose_counter", { pricePaise: 900 }, { pricePaise: 900 }),
      pair("normalise_quotes", { terms: [{ quoteId: "a", deliveryChargePaise: 5, gstPercent: 18 }] }, { terms: [{ quoteId: "a", deliveryChargePaise: 5, gstPercent: 18 }] }),
      pair("normalise_quotes", { terms: [{ quoteId: "a", deliveryChargePaise: 5, gstPercent: 18 }] }, { terms: [{ quoteId: "a", deliveryChargePaise: 9, gstPercent: 18 }] }),
      pair("normalise_quotes", { terms: [] }, { terms: [] }),
    ]);
    expect(get(out, "extract_document").agreement).toBe(0.5);
    expect(get(out, "inspect_dispatch").agreement).toBe(0);
    expect(get(out, "dispute_brief").agreement).toBe(1);
    expect(get(out, "draft_quote").agreement).toBe(0.6);
    expect(get(out, "propose_counter").agreement).toBe(1);
    expect(get(out, "normalise_quotes").agreement).toBeCloseTo(0.333, 3);
  });

  it("uses the family's own review threshold", () => {
    const out = summariseShadowPairs([{ capability: "dispute_brief", live: side({}, 0.7), shadow: side({}, 0.5) }]);
    expect(get(out, "dispute_brief").reviewRate).toEqual({ live: 0, shadow: 1 });
  });
});
