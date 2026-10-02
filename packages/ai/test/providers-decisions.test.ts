import { prisma } from "@cnote/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { anthropicProviders, countOpenReviews, getProviders, getReview, heuristicProviders, listOpenReviews, moderate, REVIEW_THRESHOLDS, scoreIntent, setProvidersForTests, worker } from "../src";
import { createAnthropicClient, AnthropicIntentScorer, AnthropicListingExtractor, type MessagesClient } from "../src/anthropic";
import { runLogged } from "../src/decisions";

const fake = (impl: (p: any, o?: any) => unknown): MessagesClient => ({ messages: { create: async (p: any, o: any) => impl(p, o) } }) as unknown as MessagesClient;
const text = (obj: unknown) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(obj) }] });
const intentIn = { title: "boxes", requirement: "need 500 corrugated boxes for shipping", buyerVerificationTier: 1, buyerPhoneVerified: true, buyerPriorEnquiries: 0, buyerPriorResponded: 0 };
const extractIn = { text: "3 ply boxes Rs 5 per piece", language: "en" as const, categories: [{ slug: "boxes", name: "Boxes", attributeSchema: {} }] };

afterEach(() => { vi.restoreAllMocks(); setProvidersForTests(null); delete process.env.AI_PROVIDER; });

describe("Anthropic failure modes fall back to heuristic on every capability", () => {
  const failures: [string, () => unknown][] = [
    ["network/API error", () => { throw new Error("ECONNRESET"); }],
    ["timeout", () => { throw Object.assign(new Error("Request timed out"), { name: "APIConnectionTimeoutError" }); }],
    ["non-Error throw", () => { throw "string failure"; }],
    ["429 rate limit", () => { throw Object.assign(new Error("429 rate_limit_error"), { status: 429 }); }],
    ["529 overloaded", () => { throw Object.assign(new Error("overloaded"), { status: 529 }); }],
    ["401 bad key", () => { throw Object.assign(new Error("invalid x-api-key"), { status: 401 }); }],
    ["refusal", () => ({ stop_reason: "refusal", content: [] })],
    ["empty content", () => ({ stop_reason: "end_turn", content: [] })],
    ["non-text block only", () => ({ stop_reason: "end_turn", content: [{ type: "tool_use" }] })],
    ["truncated JSON", () => ({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"score": 5' }] })],
    ["non-JSON prose", () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "Sure! Here you go" }] })],
    ["schema mismatch", () => text({ wrong: 1 })],
    ["wrong types", () => text({ score: "high", reasons: "x", confidence: "1" })],
  ];
  it.each(failures)("%s", async (_n, impl) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = anthropicProviders(fake(impl));
    const i = await p.intent.score(intentIn);
    const e = await p.extractor.extract(extractIn);
    const m = await p.moderator.moderate({ text: "tramadol tablets" });
    for (const r of [i, e, m]) { expect(r.provider).toBe("heuristic-fallback"); expect(r.modelId).toBe("heuristic-v1"); }
    expect(m.output.verdict).toBe("block"); // safety net still blocks
    expect(e.output.pricePaise).toBe(500);
    expect(i.output.score).toBeGreaterThanOrEqual(0);
  });
  it("fallback disabled propagates the error", async () => {
    const p = anthropicProviders(fake(() => { throw new Error("boom"); }), false);
    await expect(p.moderator.moderate({ text: "x" })).rejects.toThrow("boom");
    await expect(p.intent.score(intentIn)).rejects.toThrow("boom");
    await expect(p.extractor.extract(extractIn)).rejects.toThrow("boom");
  });
  it("success path: extractor coerces numeric attrs, rounds paise, sanitises hsn, clamps confidence; moderation passthrough", async () => {
    const p = anthropicProviders(fake((params) => {
      const sys = params.system[0].text as string;
      if (sys.includes("moderate")) return text({ verdict: "review", flags: ["pharma"], reason: "hmm", confidence: 7 });
      return text({ title: "Box", description: "d", categorySlug: "boxes", attributes: [{ key: "ply", value: "3" }, { key: "colour", value: "  " }, { key: "grade", value: "A" }], pricePaise: 519.6, priceUnit: "piece", moq: 5, moqUnit: null, hsn: "481910", confidence: -2 });
    }));
    const r = await p.extractor.extract(extractIn);
    expect(r.output).toMatchObject({ categorySlug: "boxes", pricePaise: 520, hsn: "481910", attributes: { ply: 3, colour: "  ", grade: "A" } });
    expect(r.confidence).toBe(0);
    const m = await p.moderator.moderate({ text: "x" });
    expect(m.confidence).toBe(1);
    expect(m.output).toEqual({ verdict: "review", flags: ["pharma"], reason: "hmm" });
    expect(m.promptVersion).toBe("moderate-v2");
  });
  it("PII never reaches the vendor for any capability", async () => {
    const sent: string[] = [];
    const p = anthropicProviders(fake((params) => { sent.push(JSON.stringify(params.messages)); throw new Error("stop"); }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await p.intent.score({ ...intentIn, requirement: "call 9876543210 mail a@b.com" });
    await p.extractor.extract({ ...extractIn, text: "PAN ABCDE1234F 9876543210" });
    await p.moderator.moderate({ text: "GSTIN 27ABCDE1234F1Z5 and 1234 5678 9012" });
    const all = sent.join("");
    for (const s of ["9876543210", "a@b.com", "ABCDE1234F", "27ABCDE1234F1Z5", "1234 5678 9012"]) expect(all).not.toContain(s);
    expect(sent).toHaveLength(3);
  });
  it("passes an 8s timeout, cached system prompt, and prompt-injection guard", async () => {
    let seen: any, opts: any;
    await new AnthropicIntentScorer(fake((p, o) => { seen = p; opts = o; return text({ score: 1, reasons: [], confidence: 1 }); })).score(intentIn);
    expect(opts.timeout).toBe(8000);
    expect(seen.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(seen.system[0].text).toMatch(/untrusted/);
    expect(seen.messages[0].content).toMatch(/^<user_input>/);
    expect(seen.temperature).toBeUndefined();
    expect(seen.output_config.effort).toBe("low");
    await new AnthropicListingExtractor(fake((p) => { seen = p; return text({ title: "", description: "", categorySlug: null, attributes: [], pricePaise: null, priceUnit: null, moq: null, moqUnit: null, hsn: null, confidence: 0.5 }); })).extract(extractIn);
    expect(seen.output_config.format.schema.type).toBe("object");
  });
  it("createAnthropicClient builds a client without network", () => {
    process.env.ANTHROPIC_API_KEY ??= "test-key";
    expect(createAnthropicClient().messages.create).toBeTypeOf("function");
  });
});

describe("registry selection", () => {
  it("defaults to heuristic, AI_PROVIDER=anthropic switches (per call), override wins", () => {
    expect(getProviders()).toBe(heuristicProviders);
    process.env.AI_PROVIDER = "anthropic"; process.env.ANTHROPIC_API_KEY ??= "test-key";
    const a = getProviders();
    expect(a).not.toBe(heuristicProviders);
    expect(getProviders()).toBe(a);
    process.env.AI_PROVIDER = "other";
    expect(getProviders()).toBe(heuristicProviders);
    setProvidersForTests(a);
    expect(getProviders()).toBe(a);
  });
});

const runId = crypto.randomUUID();
const subj = (n: string) => ({ type: "listing" as const, id: `test-${runId}-${n}` });
afterAll(async () => {
  await prisma.reviewItem.deleteMany({ where: { subjectId: { startsWith: `test-${runId}` } } });
  await prisma.aiDecision.deleteMany({ where: { subjectId: { startsWith: `test-${runId}` } } });
});
const res = (confidence: number, output: object = { ok: 1 }) => async () => ({ output, confidence, provider: "heuristic", modelId: "m", promptVersion: "p" });

describe("review thresholds (boundaries)", () => {
  it.each(Object.entries(REVIEW_THRESHOLDS) as [keyof typeof REVIEW_THRESHOLDS, number][])("%s: below threshold reviews, at/above does not", async (cap, th) => {
    const below = await runLogged(cap, subj(`${cap}-below`), {}, res(th - 0.01));
    const at = await runLogged(cap, subj(`${cap}-at`), {}, res(th));
    const above = await runLogged(cap, subj(`${cap}-above`), {}, res(1));
    expect([below.needsReview, at.needsReview, above.needsReview]).toEqual([true, false, false]);
    const rev = await prisma.reviewItem.findFirstOrThrow({ where: { aiDecisionId: below.decisionId } });
    expect(rev.reason).toMatch(/Low confidence/);
    expect(await prisma.reviewItem.count({ where: { aiDecisionId: at.decisionId } })).toBe(0);
  });
  it("forced review beats high confidence and its reason is used; null force falls back to threshold", async () => {
    const r = await runLogged("moderate", subj("force"), {}, res(0.99), () => "forced!");
    expect(r.needsReview).toBe(true);
    expect((await prisma.reviewItem.findFirstOrThrow({ where: { aiDecisionId: r.decisionId } })).reason).toBe("forced!");
    expect((await runLogged("moderate", subj("noforce"), {}, res(0.99), () => null)).needsReview).toBe(false);
  });
  it("provider failure writes no decision (nothing half-logged)", async () => {
    const before = await prisma.aiDecision.count({ where: { subjectId: subj("fail").id } });
    await expect(runLogged("intent", subj("fail"), {}, async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(await prisma.aiDecision.count({ where: { subjectId: subj("fail").id } })).toBe(before);
  });
  it("moderation via public API: fallback provider label is stored on the decision", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setProvidersForTests(anthropicProviders(fake(() => { throw new Error("down"); })));
    const r = await moderate({ text: "pistol for sale" }, subj("fb"));
    expect(r.verdict).toBe("block");
    expect((await prisma.aiDecision.findUniqueOrThrow({ where: { id: r.decisionId } })).provider).toBe("heuristic-fallback");
    setProvidersForTests(null);
  });
  it("listOpenReviews clamps limit; getReview/countOpenReviews", async () => {
    const r = await scoreIntent({ ...intentIn, requirement: "x" }, { type: "enquiry", id: `test-${runId}-enq` });
    expect(r.needsReview).toBe(true);
    expect((await listOpenReviews(-5)).length).toBeLessThanOrEqual(1);
    const item = await prisma.reviewItem.findFirstOrThrow({ where: { aiDecisionId: r.decisionId } });
    expect(await getReview("nope")).toBeNull();
    expect(await getReview(crypto.randomUUID())).toBeNull();
    expect(await getReview(item.id)).toMatchObject({ id: item.id, status: "open", capability: "intent" });
    expect(await countOpenReviews("enquiry")).toBeGreaterThanOrEqual(1);
    expect(await countOpenReviews()).toBeGreaterThanOrEqual(await countOpenReviews("enquiry"));
  });
});

describe("worker", () => {
  it("registers a daily purge job that runs", async () => {
    expect(worker.name).toBe("ai");
    const job = worker.jobs![0]!;
    expect(job.name).toBe("ai.purge-decision-inputs");
    expect(job.everyMs).toBe(86_400_000);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const old = await prisma.aiDecision.create({ data: { capability: "moderate", provider: "h", modelId: "x", promptVersion: "x", inputRedacted: { text: "s" }, output: {}, confidence: 0.9, subjectType: "listing", subjectId: `test-${runId}-purge`, latencyMs: 1, createdAt: new Date(Date.now() - 181 * 86_400_000) } });
    const fresh = await prisma.aiDecision.create({ data: { capability: "moderate", provider: "h", modelId: "x", promptVersion: "x", inputRedacted: { text: "s" }, output: {}, confidence: 0.9, subjectType: "listing", subjectId: `test-${runId}-fresh`, latencyMs: 1, createdAt: new Date(Date.now() - 179 * 86_400_000) } });
    await job.run();
    expect((await prisma.aiDecision.findUniqueOrThrow({ where: { id: old.id } })).inputRedacted).toEqual({ purged: true });
    expect((await prisma.aiDecision.findUniqueOrThrow({ where: { id: fresh.id } })).inputRedacted).toEqual({ text: "s" });
    expect(log).toHaveBeenCalled();
    await job.run(); // idempotent
  });
});
