import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  briefDispute, briefDisputeHeuristic, getDispatchInspector, getDocumentExtractor, getProviders, getQuoteProviders, getSpeechToText, heuristicProviders,
  inspectDispatchHeuristic, scoreIntent, setDisputeBriefProviderForTests, setProvidersForTests, embed, type BriefDisputeInput,
} from "../src";
import {
  AI_CAPABILITIES, aiServiceClientFromEnv, aiTransport, remoteCall, remoteDispatchInspector, remoteDisputeProvider, remoteDocumentExtractor, remoteEmbedder,
  remoteFallbackEnabled, remoteProviders, remoteQuoteProviders, remoteSpeechToText, resetSharedAiServiceClientForTests, sharedAiServiceClient,
} from "../src/remote";
import { ServiceClient, ServiceRejectedError, ServiceUnavailableError, verifyServiceToken } from "../src/service-client";
import { extractDocumentHeuristic } from "../src/document";
import { heuristicQuoteProviders } from "../src/quotes";
import { localEmbedder } from "../src/embedder";

const SECRET = "remote-test-secret-0123456789abcdef";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const client = (fetchImpl: typeof fetch, retries = 0) => new ServiceClient({ name: "ai-service", baseUrl: "http://ai", audience: "ai-service", issuer: "t", secret: SECRET, fetchImpl, sleep: async () => {}, retries });
const down = (async () => json(503, { error: { message: "down" } })) as unknown as typeof fetch;
const okResult = (output: unknown, extra = {}) => ({ output, confidence: 0.9, provider: "heuristic", modelId: "m", promptVersion: "p", ...extra });
const intentInput = { title: "Boxes", requirement: "500 corrugated boxes", buyerVerificationTier: 1, buyerPhoneVerified: true, buyerPriorEnquiries: 0, buyerPriorResponded: 0 };

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); setProvidersForTests(null); setDisputeBriefProviderForTests(null); resetSharedAiServiceClientForTests();
  for (const k of ["AI_TRANSPORT", "AI_REMOTE_FALLBACK", "AI_SERVICE_URL", "AI_SERVICE_TOKEN_SECRET", "AI_SERVICE_TIMEOUT_MS", "AI_SERVICE_RETRIES", "SERVICE_NAME"]) delete process.env[k];
});

describe("env selection", () => {
  it("defaults to in-process with fallback on", () => {
    expect(aiTransport({})).toBe("inproc");
    expect(aiTransport({ AI_TRANSPORT: "http" })).toBe("http");
    expect(aiTransport({ AI_TRANSPORT: "grpc" })).toBe("inproc");
    expect(remoteFallbackEnabled({})).toBe(true);
    expect(remoteFallbackEnabled({ AI_REMOTE_FALLBACK: "none" })).toBe(false);
  });
  it("builds a client from env and insists on URL + secret", () => {
    expect(() => aiServiceClientFromEnv({})).toThrow(/AI_SERVICE_URL/);
    expect(() => aiServiceClientFromEnv({ AI_SERVICE_URL: "http://x" })).toThrow(/AI_SERVICE_TOKEN_SECRET/);
    expect(aiServiceClientFromEnv({ AI_SERVICE_URL: "http://x", AI_SERVICE_TOKEN_SECRET: SECRET, AI_SERVICE_TIMEOUT_MS: "abc", AI_SERVICE_RETRIES: "3", SERVICE_NAME: "worker" })).toBeInstanceOf(ServiceClient);
  });
  it("shares one client per process", () => {
    process.env.AI_SERVICE_URL = "http://x"; process.env.AI_SERVICE_TOKEN_SECRET = SECRET;
    expect(sharedAiServiceClient()).toBe(sharedAiServiceClient());
  });
  it("declares every capability once, with a unique path; only transcribe is non-retryable", () => {
    const paths = Object.values(AI_CAPABILITIES).map((c) => c.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(Object.entries(AI_CAPABILITIES).filter(([, c]) => !c.retry).map(([k]) => k)).toEqual(["transcribe"]);
  });
});

describe("remoteCall", () => {
  it("wraps the input and returns the ProviderResult untouched", async () => {
    const f = vi.fn(async (_u: any, init: any) => { expect(JSON.parse(init.body)).toEqual({ input: { a: 1 } }); return json(200, okResult({ x: 1 })); }) as unknown as typeof fetch;
    const r = await remoteCall<{ a: number }, { x: number }>(client(f), "moderate", null)({ a: 1 });
    expect(r.output).toEqual({ x: 1 });
    expect(r.provider).toBe("heuristic");
  });
  it("falls back to the local provider (tagged) only when the service is unavailable", async () => {
    const local = vi.fn(async () => okResult({ x: "local" }, { provider: "heuristic" })) as unknown as (i: unknown) => Promise<{ output: { x: string }; confidence: number; provider: string; modelId: string; promptVersion: string }>;
    const r = await remoteCall<unknown, { x: string }>(client(down), "moderate", local)({});
    expect(r).toMatchObject({ output: { x: "local" }, provider: "heuristic-fallback" });
    expect(local).toHaveBeenCalledTimes(1);
  });
  it("does not fall back on 4xx: bad credentials and bad input surface", async () => {
    const local = vi.fn();
    const f = (async () => json(401, { error: { message: "no" } })) as unknown as typeof fetch;
    await expect(remoteCall(client(f), "moderate", local as any)({})).rejects.toThrow(ServiceRejectedError);
    expect(local).not.toHaveBeenCalled();
  });
  it("propagates unavailability when there is no fallback (queue consumers retry)", async () => {
    await expect(remoteCall(client(down), "transcribe", null)({})).rejects.toThrow(ServiceUnavailableError);
  });
  it("treats a malformed ProviderResult as unavailability (and falls back)", async () => {
    for (const body of [null, { output: 1 }, { output: 1, confidence: "hi", provider: "x" }, { confidence: 1, provider: "x" }]) {
      const f = (async () => json(200, body)) as unknown as typeof fetch;
      await expect(remoteCall(client(f), "moderate", null)({})).rejects.toThrow(/malformed ProviderResult/);
    }
    const f = (async () => json(200, { output: 1 })) as unknown as typeof fetch;
    const r = await remoteCall<unknown, unknown>(client(f), "moderate", async () => okResult("l"))({});
    expect(r.provider).toBe("heuristic-fallback");
  });
  it("retries idempotent capabilities, but transcribe exactly once", async () => {
    const f = vi.fn(down);
    await remoteCall(client(f as any, 2), "moderate", null)({}).catch(() => {});
    expect(f).toHaveBeenCalledTimes(3);
    const g = vi.fn(down);
    await remoteCall(client(g as any, 2), "transcribe", null)({}).catch(() => {});
    expect(g).toHaveBeenCalledTimes(1);
  });
  it("signs every call for the ai-service audience", async () => {
    const f = vi.fn(async (_u: any, init: any) => {
      expect(verifyServiceToken(String(init.headers.authorization).slice(7), { secret: SECRET, audience: "ai-service" }).ok).toBe(true);
      return json(200, okResult(1));
    }) as unknown as typeof fetch;
    await remoteCall(client(f), "moderate", null)({});
    expect(f).toHaveBeenCalledOnce();
  });
});

describe("remote providers", () => {
  const route = (map: Record<string, (input: any) => unknown>) => vi.fn(async (url: any, init: any) => {
    const h = map[new URL(String(url)).pathname];
    return h ? json(200, h(JSON.parse(init.body).input)) : json(404, { error: { message: "nope" } });
  }) as unknown as typeof fetch;

  it("maps every Providers port to its endpoint", async () => {
    const calls: string[] = [];
    const f = vi.fn(async (url: any) => { calls.push(new URL(String(url)).pathname); return json(200, okResult({ vectors: [[1, 2]], version: localEmbedder.version })); }) as unknown as typeof fetch;
    const p = remoteProviders(client(f), heuristicProviders);
    await p.intent.score({} as any); await p.extractor.extract({} as any); await p.moderator.moderate({} as any); await p.imageExtractor!.extract({} as any); await p.embedder.embed(["a"]);
    expect(calls).toEqual(["/v1/score-intent", "/v1/extract-listing", "/v1/moderate", "/v1/extract-listing-from-images", "/v1/embed"]);
  });
  it("without fallback every port propagates outages", async () => {
    const p = remoteProviders(client(down), heuristicProviders, false);
    await expect(p.intent.score(intentInput)).rejects.toThrow(ServiceUnavailableError);
    await expect(p.embedder.embed(["a"])).rejects.toThrow(ServiceUnavailableError);
  });
  it("with fallback answers in-process when the service is down (same outputs as the heuristic)", async () => {
    const p = remoteProviders(client(down), heuristicProviders);
    const r = await p.intent.score(intentInput);
    expect(r.provider).toBe("heuristic-fallback");
    expect(r.output).toEqual((await heuristicProviders.intent.score(intentInput)).output);
    const e = await p.embedder.embed(["steel pipes"]);
    expect(e).toEqual(await localEmbedder.embed(["steel pipes"]));
  });
  it("every port falls back to its in-process heuristic when the service is down", async () => {
    const p = remoteProviders(client(down), heuristicProviders);
    const cats = [{ slug: "boxes", name: "Boxes", attributeSchema: {} }];
    expect((await p.extractor.extract({ text: "500 corrugated boxes", language: "en", categories: cats })).provider).toBe("heuristic-fallback");
    expect((await p.moderator.moderate({ text: "cotton shirts" })).provider).toBe("heuristic-fallback");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
    expect((await p.imageExtractor!.extract({ images: [{ bytes: png, mimeType: "image/png" }], language: "en", categories: cats })).provider).toBe("heuristic-fallback");
  });
  it("embedder validates the vector count and warns on version skew", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const skew = remoteEmbedder(client(route({ "/v1/embed": () => okResult({ vectors: [[1]], version: "other" }) })), localEmbedder, false);
    await expect(skew.embed(["a"])).resolves.toEqual([[1]]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("version mismatch"));
    const short = remoteEmbedder(client(route({ "/v1/embed": () => okResult({ vectors: [], version: localEmbedder.version }) })), localEmbedder, false);
    await expect(short.embed(["a"])).rejects.toThrow(/vector count mismatch/);
    expect(skew.version).toBe(localEmbedder.version);
  });
  it("speech has no fallback and reports the transport name", async () => {
    const s = remoteSpeechToText(client(down));
    expect(s.name).toBe("remote");
    await expect(s.transcribe({ audio: { bytes: new Uint8Array([1]), mimeType: "audio/wav" } })).rejects.toThrow(ServiceUnavailableError);
  });
  it("document, inspection, dispute and quote providers use their endpoints and fall back when given a local provider", async () => {
    const paths: string[] = [];
    const f = vi.fn(async (url: any) => { paths.push(new URL(String(url)).pathname); return json(200, okResult({})); }) as unknown as typeof fetch;
    const c = client(f);
    await remoteDocumentExtractor(c, null).extract({} as any);
    await remoteDispatchInspector(c, null).inspect({} as any);
    await remoteDisputeProvider(c, null).brief({} as any);
    const q = remoteQuoteProviders(c, null);
    await q.drafter.draft({} as any); await q.normaliser.normalise({} as any); await q.countering.propose({} as any);
    expect(paths).toEqual(["/v1/extract-document", "/v1/inspect-dispatch", "/v1/brief-dispute", "/v1/draft-quote", "/v1/normalise-quotes", "/v1/propose-counter"]);

    const dc = client(down);
    expect((await remoteDocumentExtractor(dc, { extract: async (i) => extractDocumentHeuristic(i) }).extract({ image: { bytes: new Uint8Array(1), mimeType: "image/png" }, docType: "pan_card" })).provider).toBe("heuristic-fallback");
    const insp = await remoteDispatchInspector(dc, { inspect: async (i) => inspectDispatchHeuristic(i) }).inspect({ images: [], expected: {} } as any);
    expect(insp.provider).toBe("heuristic-fallback");
    const fq = remoteQuoteProviders(dc, heuristicQuoteProviders);
    await fq.normaliser.normalise({ quotes: [] } as any).catch(() => {});
    await fq.countering.propose({} as any).catch(() => {});
    await expect(fq.drafter.draft({ } as any)).rejects.toBeDefined(); // the heuristic itself rejects an empty input: error surfaces, not swallowed
  });
});

describe("registry wiring (AI_TRANSPORT=http)", () => {
  beforeEach(() => { process.env.AI_TRANSPORT = "http"; process.env.AI_SERVICE_URL = "http://ai.internal"; process.env.AI_SERVICE_TOKEN_SECRET = SECRET; process.env.AI_SERVICE_RETRIES = "1"; });

  it("getProviders/embed/scoreIntent go over HTTP, keeping decision logging in-process", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
      const path = new URL(String(url)).pathname; paths.push(path);
      if (path === "/v1/embed") return json(200, okResult({ vectors: JSON.parse(init.body).input.texts.map(() => [0.5]), version: localEmbedder.version }));
      return json(200, okResult({ score: 77, reasons: ["remote"] }, { confidence: 0.95, provider: "remote-model" }));
    }));
    expect(getProviders()).toBe(getProviders());
    const r = await scoreIntent(intentInput, { type: "enquiry", id: randomUUID() });
    expect(r).toMatchObject({ score: 77, needsReview: false });
    expect(r.decisionId).toBeTruthy(); // AiDecision written locally
    expect((await embed(["x", "y"])).vectors).toEqual([[0.5], [0.5]]);
    expect(paths).toEqual(["/v1/score-intent", "/v1/embed"]);
  });
  it("falls back to the heuristic and honours AI_REMOTE_FALLBACK=none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(503, {})));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await getProviders().intent.score(intentInput)).provider).toBe("heuristic-fallback");
    setProvidersForTests(null); process.env.AI_REMOTE_FALLBACK = "none";
    await expect(getProviders().intent.score(intentInput)).rejects.toThrow(ServiceUnavailableError);
  });
  it("routes the other capabilities' getters through the service", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any) => { paths.push(new URL(String(url)).pathname); return json(200, okResult({})); }));
    await getDocumentExtractor().extract({} as any);
    await getDispatchInspector().inspect({} as any);
    await getQuoteProviders().drafter.draft({} as any);
    await getSpeechToText().transcribe({} as any);
    expect(paths).toEqual(["/v1/extract-document", "/v1/inspect-dispatch", "/v1/draft-quote", "/v1/transcribe"]);
    // and the fallback-less variants
    process.env.AI_REMOTE_FALLBACK = "none";
    vi.stubGlobal("fetch", vi.fn(async () => json(503, {})));
    await expect(getDocumentExtractor().extract({} as any)).rejects.toThrow(ServiceUnavailableError);
    // default fallback: in-process heuristics answer, tagged as such
    delete process.env.AI_REMOTE_FALLBACK;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const doc = await getDocumentExtractor().extract({ image: { bytes: new Uint8Array(1), mimeType: "image/png" }, docType: "pan_card" });
    expect(doc.provider).toBe("heuristic-fallback");
    expect((await getDispatchInspector().inspect({ images: [], expected: {} } as any)).provider).toBe("heuristic-fallback");
    process.env.AI_REMOTE_FALLBACK = "none";
    await expect(getDispatchInspector().inspect({} as any)).rejects.toThrow(ServiceUnavailableError);
    await expect(getQuoteProviders().drafter.draft({} as any)).rejects.toThrow(ServiceUnavailableError);
  });
  it("briefDispute goes through the service and logs locally; falls back to the heuristic by default", async () => {
    const input: BriefDisputeInput = {
      claimedType: "damaged", claimedAmountPaise: 100, atStakePaise: 1000,
      order: { totalPaise: 1000, quantity: 10, unit: "box", pricePaise: 100, status: "delivered" },
      quote: { pricePaise: 100, quantity: 10, unit: "box", leadTimeDays: 5, notes: null },
      evidence: [], qualityChecks: [], counterpartyResponded: true,
    };
    const local = briefDisputeHeuristic(input);
    const f = vi.fn(async () => json(200, local));
    vi.stubGlobal("fetch", f);
    const r = await briefDispute(input, { type: "dispute", id: randomUUID() });
    expect(f).toHaveBeenCalledOnce();
    expect(r.decisionId).toBeTruthy();
    vi.stubGlobal("fetch", vi.fn(async () => json(503, {})));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(briefDispute(input, { type: "dispute", id: randomUUID() })).resolves.toMatchObject({ classifiedType: "damaged" });
    process.env.AI_REMOTE_FALLBACK = "none";
    await expect(briefDispute(input, { type: "dispute", id: randomUUID() })).rejects.toThrow(ServiceUnavailableError);
  });
});
