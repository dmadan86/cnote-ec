// Contract tests (ADR-018): every capability yields the SAME provider result in-process and over the HTTP service, using the
// deterministic heuristic providers. The remote side goes through the real client (tokens, wire codec) into the real app.
import { ServiceClient } from "@cnote/ai/service-client";
import {
  briefDisputeHeuristic, heuristicDisputeProvider, heuristicProviders, heuristicQuoteProviders, getDocumentExtractor, getDispatchInspector, getSpeechToText,
  type BriefDisputeInput, type DraftQuoteInput, type ProposeCounterInput,
} from "@cnote/ai";
import { remoteDispatchInspector, remoteDisputeProvider, remoteDocumentExtractor, remoteProviders, remoteQuoteProviders, remoteSpeechToText } from "@cnote/ai/remote";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { jpegNoExif, mockAudio, syntheticPng } from "../../../packages/ai/evals/fixtures";

// By default the suite runs against the in-process Hono app. To validate ANOTHER implementation of the contract (e.g. the
// Python service of ADR-018) run it against that instead:
//   AI_CONTRACT_URL=http://localhost:8000 AI_CONTRACT_SECRET=... pnpm --filter @cnote/ai-service test contract
const EXTERNAL = process.env.AI_CONTRACT_URL;
const SECRET = process.env.AI_CONTRACT_SECRET ?? "contract-test-secret-0123456789abcdef";
const app = createApp({ config: { port: 0, tokenSecret: SECRET, maxInflight: 16, maxBodyBytes: 20 * 1024 * 1024 }, log: () => {}, env: {} });
const client = new ServiceClient({
  name: "ai-service", baseUrl: EXTERNAL ?? "http://ai.test", audience: "ai-service", issuer: "contract-test", secret: SECRET, retries: 0,
  ...(EXTERNAL ? {} : { fetchImpl: (async (url: string, init: RequestInit) => app.request(new URL(url).pathname, init)) as unknown as typeof fetch }),
});
/** what a JSON hop does to a value (undefined dropped, bytes encoded and decoded elsewhere) */
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const cats = [{ slug: "packaging-boxes", name: "Packaging boxes", attributeSchema: {} }];
const png = () => syntheticPng(64, 48, "checker", [200, 30, 30]);
const remote = remoteProviders(client, heuristicProviders, false);

describe("Providers contract: in-process === over HTTP", () => {
  it("scoreIntent", async () => {
    const input = { title: "Corrugated boxes", requirement: "Need 500 3 ply boxes delivered to Pune, call 9876543210", quantity: 500, quantityUnit: "pcs", targetPricePaise: 4800, deliveryPincode: "411001", neededBy: "2026-11-01", buyerVerificationTier: 2, buyerPhoneVerified: true, buyerPriorEnquiries: 3, buyerPriorResponded: 2, nearDuplicateSimilarity: 0.1 };
    expect(await remote.intent.score(input)).toEqual(wire(await heuristicProviders.intent.score(input)));
  });
  it("embed (same vectors, same version)", async () => {
    const texts = ["steel pipes", "कपड़े की दुकान", "corrugated box 3 ply"];
    expect(await remote.embedder.embed(texts)).toEqual(await heuristicProviders.embedder.embed(texts));
    expect(remote.embedder.version).toBe(heuristicProviders.embedder.version);
  });
  it("extractListing", async () => {
    const input = { text: "3 ply corrugated boxes, 20 rupees per piece, minimum 500 pieces, GST 12%", language: "en" as const, categories: cats };
    expect(await remote.extractor.extract(input)).toEqual(wire(await heuristicProviders.extractor.extract(input)));
  });
  it("moderate (allow, review and block verdicts)", async () => {
    for (const text of ["cotton t-shirts", "prescription medicines without licence", "hand made country pistols"]) {
      expect(await remote.moderator.moderate({ text })).toEqual(wire(await heuristicProviders.moderator.moderate({ text })));
    }
  });
  it("extractListingFromImages (bytes survive the wire)", async () => {
    const input = { images: [{ bytes: png(), mimeType: "image/png", width: 64, height: 48 }, { bytes: jpegNoExif(), mimeType: "image/jpeg" }], hintText: "red box", language: "en" as const, categories: cats };
    expect(await remote.imageExtractor!.extract(input)).toEqual(wire(await heuristicProviders.imageExtractor!.extract(input)));
  });
});

describe("other capabilities: in-process === over HTTP", () => {
  it("transcribe", async () => {
    const input = { audio: { bytes: mockAudio("500 boxes at 20 rupees"), mimeType: "audio/wav" } };
    expect(await remoteSpeechToText(client).transcribe(input)).toEqual(wire(await getSpeechToText().transcribe(input)));
  });
  it("extractDocument", async () => {
    const input = { image: { bytes: png(), mimeType: "image/png" }, docType: "pan_card" as const };
    expect(await remoteDocumentExtractor(client, null).extract(input)).toEqual(wire(await getDocumentExtractor().extract(input)));
  });
  it("inspectDispatch", async () => {
    const input = {
      images: [{ bytes: png(), mimeType: "image/png", width: 64, height: 48 }], language: "en" as const,
      expected: { categorySlug: "boxes", productTitle: "3 ply box", quantity: 100, unit: "piece", requirement: "brand visible", attributes: { ply: 3 }, labelling: ["brand"] },
    };
    expect(await remoteDispatchInspector(client, null).inspect(input)).toEqual(wire(await getDispatchInspector().inspect(input)));
  });
  it("briefDispute", async () => {
    const input: BriefDisputeInput = {
      claimedType: "damaged", claimedAmountPaise: 400_000, atStakePaise: 1_000_000,
      order: { totalPaise: 1_000_000, quantity: 100, unit: "box", pricePaise: 10_000, status: "delivered" },
      quote: { pricePaise: 10_000, quantity: 100, unit: "box", leadTimeDays: 5, notes: null },
      evidence: [{ id: "e1", party: "buyer", kind: "statement", text: "Cartons arrived crushed and broken" }], qualityChecks: [], counterpartyResponded: true,
    };
    const r = await remoteDisputeProvider(client, null).brief(input);
    expect(r).toEqual(wire(await heuristicDisputeProvider.brief(input)));
    expect(r.output).toEqual(wire(briefDisputeHeuristic(input).output));
  });
  it("draftQuote, normaliseQuotes, proposeCounter", async () => {
    const draft: DraftQuoteInput = {
      rfq: { title: "Corrugated boxes", requirement: "3 ply boxes", quantity: 600, unit: "pcs", targetPricePaise: 4400, neededBy: null, deliveryCity: "Pune", deliveryPincode: "411001" },
      priceBook: { basePricePaise: 5000, unit: "pcs", tiers: [{ minQty: 500, pricePaise: 4800 }], floorPricePaise: 4200, moq: 100, leadTimeDays: 7, deliveryTerms: "Freight extra", gstPercent: 18, gstIncluded: false, validityDays: 7 },
      history: { quotesSent: 0, recent: [] }, today: "2026-10-01",
    };
    const norm = { quotes: [{ quoteId: "q1", pricePaise: 5000, quantity: 500, unit: "pcs", notes: "Freight Rs. 2,500 extra. GST @ 18% extra. 50% advance" }] };
    const counter: ProposeCounterInput = {
      enquiryTitle: "Boxes", quote: { pricePaise: 5000, quantity: 500, unit: "pcs", leadTimeDays: 14 },
      bounds: { targetPricePaise: 4500, ceilingPricePaise: 4800, maxLeadTimeDays: 10 }, peers: { count: 3, bestLandedPricePaise: 5200, thisLandedPricePaise: 5900 },
    };
    const q = remoteQuoteProviders(client, null);
    expect(await q.drafter.draft(draft)).toEqual(wire(await heuristicQuoteProviders.drafter.draft(draft)));
    expect(await q.normaliser.normalise(norm)).toEqual(wire(await heuristicQuoteProviders.normaliser.normalise(norm)));
    expect(await q.countering.propose(counter)).toEqual(wire(await heuristicQuoteProviders.countering.propose(counter)));
  });
});
