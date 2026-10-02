import { prisma } from "@cnote/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  compareShadowDecisions, extractListing, extractListingFromImages, flushShadowDecisions, getShadowProviders, heuristicProviders, moderate, scoreIntent,
  setProvidersForTests, setShadowProvidersForTests, summariseShadowPairs, type ShadowPair,
} from "../src";
import { percentile } from "../src/shadow-report";
import { syntheticPng } from "../evals/fixtures";

const runId = crypto.randomUUID();
const subject = (n: string) => ({ type: "listing" as const, id: `test-${runId}-${n}` });
const ENV = ["AI_PROVIDER", "AI_SHADOW_PROVIDER", "AI_SHADOW_MODEL_REASONING", "AI_SHADOW_MODEL_FAST"] as const;

afterEach(() => {
  setProvidersForTests(null);
  setShadowProvidersForTests(null);
  for (const k of ENV) delete process.env[k];
  vi.restoreAllMocks();
});
afterAll(async () => {
  await prisma.reviewItem.deleteMany({ where: { subjectId: { startsWith: `test-${runId}` } } });
  await prisma.aiDecision.deleteMany({ where: { subjectId: { startsWith: `test-${runId}` } } });
});

describe("getShadowProviders", () => {
  it("is off unless AI_SHADOW_PROVIDER names a provider", () => {
    expect(getShadowProviders()).toBeNull();
    process.env.AI_SHADOW_PROVIDER = "gpt";
    expect(getShadowProviders()).toBeNull();
  });
  it("skips a candidate that would just repeat the live provider", () => {
    process.env.AI_SHADOW_PROVIDER = "heuristic";
    expect(getShadowProviders()).toBeNull();
  });
  it("builds a candidate when the provider or model differs, and caches it", () => {
    process.env.AI_SHADOW_PROVIDER = "heuristic";
    process.env.AI_SHADOW_MODEL_FAST = "claude-candidate";
    const a = getShadowProviders();
    expect(a).toBe(heuristicProviders);
    process.env.AI_SHADOW_PROVIDER = "anthropic";
    process.env.AI_SHADOW_MODEL_REASONING = "claude-candidate";
    const b = getShadowProviders();
    expect(b).not.toBeNull();
    expect(getShadowProviders()).toBe(b);
    process.env.AI_SHADOW_MODEL_REASONING = "";
    process.env.AI_SHADOW_MODEL_FAST = "";
    process.env.AI_PROVIDER = "heuristic";
    expect(getShadowProviders()).not.toBeNull(); // anthropic vs live heuristic
    process.env.AI_PROVIDER = "anthropic";
    expect(getShadowProviders()).toBeNull(); // same provider, same models
  });
});

describe("shadow decisions", () => {
  it("logs a shadow row beside the live one, never queues a review, and does not change the live answer", async () => {
    const candidate = { ...heuristicProviders, moderator: { moderate: async () => ({ output: { verdict: "review" as const, flags: ["pharma"], reason: "candidate unsure" }, confidence: 0.3, provider: "anthropic", modelId: "claude-candidate", promptVersion: "moderate-v2" }) } };
    setShadowProvidersForTests(candidate);
    const live = await moderate({ text: "Corrugated boxes 5 ply" }, subject("m1"));
    expect(live).toMatchObject({ verdict: "allow", needsReview: false });
    await flushShadowDecisions();
    const rows = await prisma.aiDecision.findMany({ where: { subjectId: subject("m1").id }, include: { reviews: true } });
    expect(rows).toHaveLength(2);
    const shadow = rows.find((r) => r.shadow)!;
    expect(shadow).toMatchObject({ shadowOfId: live.decisionId, modelId: "claude-candidate", promptVersion: "moderate-v2", capability: "moderate", confidence: 0.3 });
    expect(shadow.reviews).toHaveLength(0); // low confidence + review verdict, yet no ops queue item
    expect(rows.find((r) => !r.shadow)!.shadowOfId).toBeNull();
  });

  it("shadows intent, extract and extract_image too", async () => {
    setShadowProvidersForTests({ ...heuristicProviders });
    const intent = await scoreIntent({ title: "boxes", requirement: "need 500 boxes", buyerVerificationTier: 1, buyerPhoneVerified: true, buyerPriorEnquiries: 0, buyerPriorResponded: 0 }, subject("i"));
    const extract = await extractListing({ text: "3 ply boxes", language: "en", categories: [] }, subject("e"));
    const image = { bytes: syntheticPng(64, 64, "stripes", [200, 10, 10]), mimeType: "image/png", width: 64, height: 64 };
    const photo = await extractListingFromImages({ images: [image], language: "en", categories: [] }, subject("p"));
    await flushShadowDecisions();
    for (const [n, live] of [["i", intent], ["e", extract], ["p", photo]] as const) {
      const shadow = await prisma.aiDecision.findFirstOrThrow({ where: { subjectId: subject(n).id, shadow: true } });
      expect(shadow.shadowOfId).toBe(live.decisionId);
    }
  });

  it("records a failing candidate as an error row and never throws to the caller", async () => {
    setShadowProvidersForTests({ ...heuristicProviders, moderator: { moderate: async () => { throw new Error("candidate 529"); } } });
    process.env.AI_SHADOW_PROVIDER = "anthropic";
    const live = await moderate({ text: "Pure cotton fabric" }, subject("err"));
    expect(live.verdict).toBe("allow");
    await flushShadowDecisions();
    const shadow = await prisma.aiDecision.findFirstOrThrow({ where: { subjectId: subject("err").id, shadow: true } });
    expect(shadow.output).toEqual({ shadowError: "candidate 529" });
    expect(shadow.confidence).toBe(0);
  });

  it("survives a non-Error throw and a logging failure", async () => {
    setShadowProvidersForTests({ ...heuristicProviders, moderator: { moderate: async () => { throw "boom"; } } });
    await moderate({ text: "Pure cotton fabric" }, subject("str"));
    await flushShadowDecisions();
    expect((await prisma.aiDecision.findFirstOrThrow({ where: { subjectId: subject("str").id, shadow: true } })).output).toEqual({ shadowError: "boom" });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setShadowProvidersForTests({ ...heuristicProviders });
    const orig = prisma.aiDecision.create.bind(prisma.aiDecision);
    let calls = 0;
    const spy = vi.spyOn(prisma.aiDecision, "create").mockImplementation(((args: never) => (++calls === 1 ? orig(args) : Promise.reject(new Error("db down")))) as never);
    const live = await moderate({ text: "Pure cotton fabric" }, subject("logfail"));
    await flushShadowDecisions();
    spy.mockRestore();
    expect(live.verdict).toBe("allow");
    expect(warn).toHaveBeenCalledWith("[ai] shadow logging failed:", "db down");
  });

  it("does nothing when shadow mode is off", async () => {
    const live = await moderate({ text: "Pure cotton fabric" }, subject("off"));
    await flushShadowDecisions();
    expect(await prisma.aiDecision.count({ where: { subjectId: subject("off").id } })).toBe(1);
    expect(live.decisionId).toBeTruthy();
  });
});

describe("shadow report", () => {
  const side = (o: Record<string, unknown>, confidence = 0.9, latencyMs = 100, modelId = "m", promptVersion = "p1") => ({ modelId, promptVersion, confidence, latencyMs, output: o });
  const pair = (capability: string, live: Record<string, unknown>, shadow: Record<string, unknown>, extra: { lc?: number; sc?: number; sl?: number } = {}): ShadowPair => ({
    capability, live: side(live, extra.lc ?? 0.9, 100, "live-model"), shadow: side(shadow, extra.sc ?? 0.9, extra.sl ?? 300, "cand-model", "p2"),
  });

  it("percentile is nearest-rank and safe on empty input", () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([7], 0)).toBe(7);
  });

  it("summarises agreement, missed blocks, review rates, latency and errors per capability", () => {
    const out = summariseShadowPairs([
      pair("moderate", { verdict: "block" }, { verdict: "allow" }, { sc: 0.5 }),
      pair("moderate", { verdict: "allow" }, { verdict: "block" }),
      pair("moderate", { verdict: "allow" }, { verdict: "allow" }),
      pair("moderate", { verdict: "allow" }, { shadowError: "x" }),
      pair("intent", { score: 70 }, { score: 75 }),
      pair("intent", { score: 70 }, { score: 20 }),
      pair("intent", { reasons: [] }, { reasons: [] }),
      pair("extract", { title: "Box", categorySlug: "a" }, { title: "box", categorySlug: "a" }),
      pair("extract_image", { title: "Box" }, { title: "Bag" }),
      pair("transcribe", { text: "x" }, { text: "y" }),
    ]);
    const get = (c: string) => out.find((x) => x.capability === c)!;
    expect(out.map((o) => o.capability)).toEqual(["extract", "extract_image", "intent", "moderate", "transcribe"]);
    const m = get("moderate");
    expect(m).toMatchObject({ pairs: 4, shadowErrors: 1, candidateMissedBlocks: 1, candidateExtraBlocks: 1 });
    expect(m.agreement).toBeCloseTo(0.333, 3);
    expect(m.reviewRate).toEqual({ live: 0, shadow: 0.333 });
    expect(m.models).toEqual({ live: ["live-model"], shadow: ["cand-model"] });
    expect(m.promptVersions.shadow).toEqual(["p2"]);
    expect(m.latencyMs).toMatchObject({ liveP50: 100, shadowP95: 300 });
    expect(get("intent").agreement).toBe(0.5);
    expect(get("extract").agreement).toBe(1);
    expect(get("extract_image").agreement).toBe(0);
    expect(get("transcribe")).toMatchObject({ agreement: null, candidateMissedBlocks: 0 });
    expect(summariseShadowPairs([pair("moderate", { verdict: "allow" }, { shadowError: "e" })])[0]).toMatchObject({ agreement: null, meanConfidence: { live: 0, shadow: 0 } });
  });

  it("reads pairs back from the AiDecision log", async () => {
    setShadowProvidersForTests({ ...heuristicProviders });
    const since = new Date(Date.now() - 1000);
    await moderate({ text: "Tramadol 100mg wholesale" }, subject("rep"));
    await flushShadowDecisions();
    const orphan = await prisma.aiDecision.create({ data: { capability: "moderate", provider: "x", modelId: "x", promptVersion: "x", inputRedacted: {}, output: {}, confidence: 1, latencyMs: 1, subjectType: "listing", subjectId: subject("orphan").id, shadow: true, shadowOfId: crypto.randomUUID() } });
    const all = await compareShadowDecisions({ since });
    expect(all.find((c) => c.capability === "moderate")!.pairs).toBeGreaterThanOrEqual(1);
    const only = await compareShadowDecisions({ since, capability: "intent", limit: 0 });
    expect(only.find((c) => c.capability !== "intent")).toBeUndefined();
    expect(orphan.shadow).toBe(true);
  });
});
