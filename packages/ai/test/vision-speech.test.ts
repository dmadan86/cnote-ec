import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anthropicProviders, extractListingFromImages, getSpeechToText, heuristicProviders, MockSpeechToText, REVIEW_THRESHOLDS,
  SarvamSpeechToText, setProvidersForTests, setSpeechToTextForTests, transcribe, MOCK_TRANSCRIPT_PREFIX,
} from "../src";
import type { MessagesClient } from "../src/anthropic";
import { assertVisionImages, hasExifMetadata } from "../src/vision";
import { jpegNoExif, jpegWithExif, mockAudio, syntheticPng } from "../evals/fixtures";

const cats = [{ slug: "boxes", name: "Boxes", attributeSchema: {} }];
const png = () => syntheticPng(64, 48, "checker", [200, 30, 30]);
const img = () => ({ bytes: png(), mimeType: "image/png", width: 64, height: 48 });
const inp = (over = {}) => ({ images: [img()], language: "en" as const, categories: cats, ...over });
const fake = (impl: (p: any, o?: any) => unknown): MessagesClient => ({ messages: { create: async (p: any, o: any) => impl(p, o) } }) as unknown as MessagesClient;
const text = (o: unknown) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(o) }] });
const visionOut = {
  title: "Red Box", description: "d", categorySlug: "boxes", attributes: [{ key: "ply", value: "3" }], pricePaise: null, priceUnit: null,
  moq: null, moqUnit: null, hsn: "12", confidence: 0.9, visualAttributes: [{ key: "colour", value: "red" }], detected: { productType: "box", quantityVisible: 2 },
};
const subject = () => ({ type: "listing" as const, id: randomUUID() });

afterEach(() => { vi.restoreAllMocks(); setProvidersForTests(null); setSpeechToTextForTests(null); delete process.env.ASR_PROVIDER; delete process.env.SARVAM_API_KEY; delete process.env.SARVAM_STT_MODEL; });

describe("image validation", () => {
  it("accepts clean PNG/JPEG/WebP-shaped inputs", () => {
    expect(() => assertVisionImages([img()])).not.toThrow();
    expect(() => assertVisionImages([{ bytes: jpegNoExif(), mimeType: "image/jpeg" }])).not.toThrow();
    const webp = new Uint8Array(24); webp.set([..."RIFF"].map((c) => c.charCodeAt(0))); webp.set([..."WEBP"].map((c) => c.charCodeAt(0)), 8);
    expect(() => assertVisionImages([{ bytes: webp, mimeType: "image/webp" }])).not.toThrow();
  });
  it.each([
    ["none", []], ["five", Array(5).fill(0).map(img)],
    ["gif", [{ bytes: png(), mimeType: "image/gif" }]],
    ["empty", [{ bytes: new Uint8Array(0), mimeType: "image/png" }]],
    ["mislabeled", [{ bytes: jpegNoExif(), mimeType: "image/png" }]],
    ["huge", [{ ...img(), width: 9000 }]],
    ["jpeg exif", [{ bytes: jpegWithExif(), mimeType: "image/jpeg" }]],
  ])("rejects %s", (_n, images) => {
    expect(() => assertVisionImages(images as never)).toThrow();
  });
  it("detects EXIF in PNG eXIf and WebP EXIF chunks and ignores clean ones", () => {
    const pngExif = Buffer.concat([png().subarray(0, 33), Buffer.from([0, 0, 0, 2, ..."eXIf"].map((x) => (typeof x === "string" ? x.charCodeAt(0) : x))), Buffer.from([1, 2, 0, 0, 0, 0])]);
    expect(hasExifMetadata(pngExif, "image/png")).toBe(true);
    expect(hasExifMetadata(png(), "image/png")).toBe(false);
    const riff = (chunks: Buffer) => Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBP"), chunks]);
    const ch = (id: string, n: number) => Buffer.concat([Buffer.from(id), Buffer.from([n, 0, 0, 0]), Buffer.alloc(n + (n & 1))]);
    expect(hasExifMetadata(riff(Buffer.concat([ch("VP8X", 3), ch("EXIF", 4)])), "image/webp")).toBe(true);
    expect(hasExifMetadata(riff(ch("VP8 ", 4)), "image/webp")).toBe(false);
    expect(hasExifMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 1]), "image/jpeg")).toBe(false);
  });
});

describe("extractListingFromImages", () => {
  it("heuristic: hint-only, low confidence, always needsReview, logs hashes not bytes", async () => {
    const r = await extractListingFromImages(inp({ hintText: "3 ply boxes, Rs 5 per piece, call 9876543210" }), subject());
    expect(r.needsReview).toBe(true);
    expect(r.confidence).toBeLessThan(REVIEW_THRESHOLDS.extract_image);
    expect(r.pricePaise).toBe(500);
    expect(r.visualAttributes).toEqual({});
    const row = await prisma.aiDecision.findUniqueOrThrow({ where: { id: r.decisionId }, include: { reviews: true } });
    expect(row.capability).toBe("extract_image");
    const logged = JSON.stringify(row.inputRedacted);
    expect(logged).not.toContain("9876543210");
    expect(logged).toMatch(/[0-9a-f]{64}/);
    expect((row.inputRedacted as any).images[0]).toMatchObject({ bytes: png().length, width: 64, height: 48, mimeType: "image/png" });
    expect(row.reviews).toHaveLength(1);
  });

  it("heuristic without hint yields an untitled low-confidence draft", async () => {
    const r = await heuristicProviders.imageExtractor!.extract({ images: [img()], language: "en", categories: cats });
    expect(r.output.title).toBe("Untitled product");
    expect(r.output.detected.productType).toBe("");
  });

  it("anthropic: sends image blocks + hint, structured output, maps result, no review when confident", async () => {
    let sent: any;
    setProvidersForTests(anthropicProviders(fake((p, o) => { sent = { p, o }; return text(visionOut); })));
    const r = await extractListingFromImages(inp({ images: [img(), img()], hintText: "red boxes" }), subject());
    const content = sent.p.messages[0].content;
    expect(content.filter((b: any) => b.type === "image")).toHaveLength(2);
    expect(content[0].source).toMatchObject({ type: "base64", media_type: "image/png" });
    expect(content.at(-1).text).toContain("red boxes");
    expect(sent.p.output_config.format.type).toBe("json_schema");
    expect(sent.o.timeout).toBeGreaterThan(8000);
    expect(r).toMatchObject({ categorySlug: "boxes", attributes: { ply: 3 }, hsn: null, visualAttributes: { colour: "red" }, detected: { productType: "box", quantityVisible: 2 }, needsReview: false });
    expect(JSON.stringify((await prisma.aiDecision.findUniqueOrThrow({ where: { id: r.decisionId } })).inputRedacted)).not.toContain(Buffer.from(png().subarray(40, 80)).toString("base64"));
  });

  it("anthropic: drops invented category, keeps valid hsn, rounds price; low confidence queues review", async () => {
    setProvidersForTests(anthropicProviders(fake(() => text({ ...visionOut, categorySlug: "nope", hsn: "4819", pricePaise: 520.4, confidence: 0.3 }))));
    const r = await extractListingFromImages(inp(), subject());
    expect(r).toMatchObject({ categorySlug: null, hsn: "4819", pricePaise: 520, needsReview: true });
  });

  it("anthropic failure falls back to the heuristic", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setProvidersForTests(anthropicProviders(fake(() => { throw new Error("boom"); })));
    const r = await extractListingFromImages(inp({ hintText: "boxes" }), subject());
    const row = await prisma.aiDecision.findUniqueOrThrow({ where: { id: r.decisionId } });
    expect(row.provider).toBe("heuristic-fallback");
    expect(r.needsReview).toBe(true);
  });

  it("providers without imageExtractor use the heuristic; invalid images never reach a provider", async () => {
    const { imageExtractor: _drop, ...rest } = heuristicProviders;
    setProvidersForTests(rest);
    expect((await extractListingFromImages(inp(), subject())).needsReview).toBe(true);
    const spy = vi.fn();
    setProvidersForTests({ ...heuristicProviders, imageExtractor: { extract: spy } });
    await expect(extractListingFromImages(inp({ images: [{ bytes: jpegWithExif(), mimeType: "image/jpeg" }] }), subject())).rejects.toThrow(/EXIF/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("transcribe (mock)", () => {
  it("is the default provider; transcribes sidecar text, logs redacted transcript", async () => {
    expect(getSpeechToText()).toBeInstanceOf(MockSpeechToText);
    const r = await transcribe({ audio: { bytes: mockAudio("boxes, call 9876543210"), mimeType: "audio/ogg; codecs=opus" }, languageHint: "hi" }, subject());
    expect(r).toMatchObject({ text: "boxes, call 9876543210", language: "hi", confidence: 0.9, needsReview: false });
    const row = await prisma.aiDecision.findUniqueOrThrow({ where: { id: r.decisionId } });
    expect(JSON.stringify(row.output)).not.toContain("9876543210");
    expect(JSON.stringify(row.inputRedacted)).toMatch(/[0-9a-f]{64}/);
    expect(row.capability).toBe("transcribe");
  });
  it("unknown audio → empty transcript, confidence 0, review queued", async () => {
    const r = await transcribe({ audio: { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/webm" } }, subject());
    expect(r).toMatchObject({ text: "", confidence: 0, needsReview: true, language: "en" });
    expect(await prisma.reviewItem.count({ where: { aiDecisionId: r.decisionId } })).toBe(1);
  });
  it.each([
    ["mime", { bytes: new Uint8Array(3), mimeType: "video/mp4" }],
    ["empty", { bytes: new Uint8Array(0), mimeType: "audio/ogg" }],
    ["too big", { bytes: new Uint8Array(10 * 1024 * 1024 + 1), mimeType: "audio/mpeg" }],
  ])("rejects %s", async (_n, audio) => {
    await expect(transcribe({ audio }, subject())).rejects.toThrow();
  });
  it("rejects recordings the provider reports as longer than 5 minutes", async () => {
    setSpeechToTextForTests({ name: "x", transcribe: async () => ({ output: { text: "hi", language: "en", confidence: 1, durationMs: 301_000 }, confidence: 1, provider: "x", modelId: "x", promptVersion: "x" }) });
    await expect(transcribe({ audio: { bytes: new Uint8Array(3), mimeType: "audio/wav" } }, subject())).rejects.toThrow(/5 minutes/);
  });
  it("selects sarvam by env (needs a key) and mock otherwise", () => {
    process.env.ASR_PROVIDER = "sarvam";
    expect(() => getSpeechToText()).toThrow(/SARVAM_API_KEY/);
    process.env.SARVAM_API_KEY = "k";
    process.env.SARVAM_STT_MODEL = "saaras:v3";
    expect(getSpeechToText()).toBeInstanceOf(SarvamSpeechToText);
    expect(getSpeechToText()).toBe(getSpeechToText()); // cached
    delete process.env.ASR_PROVIDER;
    expect(getSpeechToText()).toBeInstanceOf(MockSpeechToText);
    expect(MOCK_TRANSCRIPT_PREFIX).toContain("MOCK");
  });
});

describe("SarvamSpeechToText", () => {
  const audio = { bytes: new Uint8Array([1, 2, 3, 4]), mimeType: "audio/ogg; codecs=opus" };
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const mk = (fetchImpl: typeof fetch, extra = {}) => new SarvamSpeechToText({ apiKey: "key", fetch: fetchImpl, sleep: async () => {}, retries: 2, ...extra });

  it("posts multipart with key header, maps transcript, language, words → segments", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const s = mk((async (url: string, init: RequestInit) => {
      seen = { url, init };
      return ok({ transcript: " gatta dabba 5 ply ", language_code: "hi-IN", language_probability: 0.95, timestamps: { words: ["gatta", "dabba"], start_time_seconds: [0, 0.5], end_time_seconds: [0.4, 1.2] } });
    }) as never, { model: "saaras:v3" });
    const r = await s.transcribe({ audio, languageHint: "hi" });
    expect(seen!.url).toBe("https://api.sarvam.ai/speech-to-text");
    expect((seen!.init.headers as Record<string, string>)["api-subscription-key"]).toBe("key");
    const form = seen!.init.body as FormData;
    expect(form.get("language_code")).toBe("hi-IN");
    expect(form.get("model")).toBe("saaras:v3");
    expect((form.get("file") as File).name).toBe("audio.ogg");
    expect(r.output).toMatchObject({ text: "gatta dabba 5 ply", language: "hi", confidence: 0.9, durationMs: 1200 });
    expect(r.output.segments).toEqual([{ text: "gatta", startMs: 0, endMs: 400 }, { text: "dabba", startMs: 500, endMs: 1200 }]);
    expect(r.provider).toBe("sarvam");
  });

  it("auto-detects language, defaults confidence, empty transcript → 0; tolerant of sparse fields", async () => {
    let form!: FormData;
    const s = mk((async (_u: string, init: RequestInit) => { form = init.body as FormData; return ok({ transcript: "hello", timestamps: { words: ["hello"] } }); }) as never);
    const r = await s.transcribe({ audio: { bytes: audio.bytes, mimeType: "audio/x-unknown" } });
    expect(form.get("language_code")).toBe("unknown");
    expect(form.has("model")).toBe(false);
    expect(r.output).toMatchObject({ language: "unknown", confidence: 0.7, durationMs: 0 });
    const e = await mk((async () => ok({})) as never).transcribe({ audio });
    expect(e.output).toMatchObject({ text: "", confidence: 0, language: "unknown" });
    expect(e.output.segments).toBeUndefined();
  });

  it("retries 429/5xx/network errors then succeeds; gives up after retries", async () => {
    let n = 0;
    const s = mk((async () => { n++; if (n === 1) return new Response("", { status: 503 }); if (n === 2) throw new Error("ECONNRESET"); return ok({ transcript: "x" }); }) as never);
    expect((await s.transcribe({ audio })).output.text).toBe("x");
    expect(n).toBe(3);
    let m = 0;
    await expect(mk((async () => { m++; return new Response("", { status: 429 }); }) as never).transcribe({ audio })).rejects.toThrow(/429/);
    expect(m).toBe(3);
  });

  it("does not retry other 4xx", async () => {
    let n = 0;
    await expect(mk((async () => { n++; return new Response("", { status: 401 }); }) as never).transcribe({ audio })).rejects.toThrow(/401/);
    expect(n).toBe(1);
  });

  it("uses global fetch and real sleep by default, and requires a key", async () => {
    expect(() => new SarvamSpeechToText({ apiKey: "" })).toThrow();
    const g = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("", { status: 500 })).mockResolvedValueOnce(ok({ transcript: "hi" }));
    vi.useFakeTimers();
    const p = new SarvamSpeechToText({ apiKey: "k", retries: 1 }).transcribe({ audio });
    await vi.advanceTimersByTimeAsync(600);
    expect((await p).output.text).toBe("hi");
    vi.useRealTimers();
    expect(g).toHaveBeenCalledTimes(2);
  });
});
