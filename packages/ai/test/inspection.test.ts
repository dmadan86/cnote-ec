import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicDispatchInspector, INSPECTION_REVIEW_THRESHOLD, anthropicDispatchInspector, deriveVerdict, getDispatchInspector, inspectDispatch,
  inspectDispatchHeuristic, normaliseChecks, setDispatchInspectorForTests, type InspectDispatchInput,
} from "../src";
import type { MessagesClient } from "../src/anthropic";
import { jpegWithExif, syntheticPng } from "../evals/fixtures";

const png = () => syntheticPng(64, 48, "checker", [200, 30, 30]);
const input = (over: Partial<InspectDispatchInput> = {}): InspectDispatchInput => ({
  images: [{ bytes: png(), mimeType: "image/png", width: 64, height: 48 }], language: "en",
  expected: { categorySlug: "boxes", productTitle: "3 ply box", quantity: 100, unit: "piece", requirement: "call 9876543210", attributes: { ply: 3 }, labelling: ["brand"] },
  ref: { orderId: randomUUID(), checkId: randomUUID() }, ...over,
});
const subject = () => ({ type: "business" as const, id: randomUUID() });
const fake = (impl: (p: any, o?: any) => unknown): MessagesClient => ({ messages: { create: async (p: any, o: any) => impl(p, o) } }) as unknown as MessagesClient;
const text = (o: unknown) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(o) }] });
const ok = (over = {}) => ({
  checks: [
    { check: "quantity", result: "consistent", confidence: 0.9, note: "about 100 boxes" },
    { check: "labelling", result: "consistent", confidence: 0.8, note: "brand visible, call 9876543210" },
    { check: "spec", result: "consistent", confidence: 0.85, note: "3 ply" },
  ],
  overallConfidence: 0.85, ...over,
});

afterEach(() => { vi.restoreAllMocks(); setDispatchInspectorForTests(null); delete process.env.AI_PROVIDER; });

describe("inspectDispatch", () => {
  it("heuristic: deterministic, all inconclusive, review queued, logs hashes and redacted expectation, no bytes", async () => {
    const r = await inspectDispatch(input(), subject());
    expect(r.verdict).toBe("inconclusive");
    expect(r.checks.map((c) => c.check)).toEqual(["quantity", "labelling", "spec"]);
    expect(r.needsReview).toBe(true);
    expect(r.confidence).toBeLessThan(INSPECTION_REVIEW_THRESHOLD);
    const row = await prisma.aiDecision.findUniqueOrThrow({ where: { id: r.decisionId }, include: { reviews: true } });
    expect(row.capability).toBe("inspect_dispatch");
    const logged = JSON.stringify(row.inputRedacted);
    expect(logged).not.toContain("9876543210");
    expect(logged).toMatch(/[0-9a-f]{64}/);
    expect(logged).not.toContain(Buffer.from(png().subarray(40, 80)).toString("base64"));
    expect(row.reviews).toHaveLength(1);
    expect(inspectDispatchHeuristic(input())).toEqual(inspectDispatchHeuristic(input()));
  });

  it("anthropic: sends images + expectation, derives verdict, redacts notes, no review when confident and consistent", async () => {
    let sent: any;
    setDispatchInspectorForTests(new AnthropicDispatchInspector(fake((p, o) => { sent = { p, o }; return text(ok()); })));
    const r = await inspectDispatch(input({ images: [input().images[0]!, input().images[0]!] }), subject());
    const content = sent.p.messages[0].content;
    expect(content.filter((b: any) => b.type === "image")).toHaveLength(2);
    expect(content.at(-1).text).not.toContain("9876543210");
    expect(content.at(-1).text).not.toContain("orderId");
    expect(sent.p.output_config.format.type).toBe("json_schema");
    expect(r.verdict).toBe("consistent");
    expect(r.checks[1]!.note).not.toContain("9876543210");
    expect(r.needsReview).toBe(false);
  });

  it("an inconsistent verdict is routed to review even when confident", async () => {
    const bad = ok(); bad.checks[0] = { check: "quantity", result: "inconsistent", confidence: 0.9, note: "only 60 visible" };
    setDispatchInspectorForTests(new AnthropicDispatchInspector(fake(() => text(bad))));
    const r = await inspectDispatch(input(), subject());
    expect(r.verdict).toBe("inconsistent");
    expect(r.needsReview).toBe(true);
  });

  it("low overall confidence queues review", async () => {
    setDispatchInspectorForTests(new AnthropicDispatchInspector(fake(() => text(ok({ overallConfidence: 0.2 })))));
    expect((await inspectDispatch(input(), subject())).needsReview).toBe(true);
  });

  it("failure falls back to heuristic; fallback=false propagates; refusal and empty content throw", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setDispatchInspectorForTests(anthropicDispatchInspector(fake(() => { throw new Error("boom"); })));
    const r = await inspectDispatch(input(), subject());
    expect((await prisma.aiDecision.findUniqueOrThrow({ where: { id: r.decisionId } })).provider).toBe("heuristic-fallback");
    await expect(anthropicDispatchInspector(fake(() => { throw new Error("x"); }), false).inspect(input())).rejects.toThrow("x");
    await expect(new AnthropicDispatchInspector(fake(() => ({ stop_reason: "refusal", content: [] }))).inspect(input())).rejects.toThrow(/refused/);
    await expect(new AnthropicDispatchInspector(fake(() => ({ stop_reason: "end_turn", content: [] }))).inspect(input())).rejects.toThrow(/no text/);
  });

  it("rejects invalid images before any provider call", async () => {
    const spy = vi.fn();
    setDispatchInspectorForTests({ inspect: spy });
    await expect(inspectDispatch(input({ images: [{ bytes: jpegWithExif(), mimeType: "image/jpeg" }] }), subject())).rejects.toThrow(/EXIF/);
    await expect(inspectDispatch(input({ images: [] }), subject())).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("getDispatchInspector follows AI_PROVIDER and caches per name", () => {
    const h = getDispatchInspector();
    expect(getDispatchInspector()).toBe(h);
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "k";
    expect(getDispatchInspector()).not.toBe(h);
  });
});

describe("verdict + normalisation", () => {
  it("deriveVerdict", () => {
    expect(deriveVerdict([])).toBe("inconclusive");
    expect(deriveVerdict([{ result: "consistent", confidence: 0.9 }, { result: "consistent", confidence: 0.1 }])).toBe("consistent");
    expect(deriveVerdict([{ result: "consistent", confidence: 0.9 }, { result: "inconclusive", confidence: 0.9 }])).toBe("inconclusive");
    expect(deriveVerdict([{ result: "inconsistent", confidence: 0.4 }, { result: "consistent", confidence: 0.9 }])).toBe("inconclusive");
    expect(deriveVerdict([{ result: "inconsistent", confidence: 0.6 }, { result: "consistent", confidence: 0.9 }])).toBe("inconsistent");
  });
  it("normaliseChecks fills missing checks, clamps and bounds notes", () => {
    const c = normaliseChecks([{ check: "quantity", result: "consistent", confidence: 7, note: "x".repeat(500) }]);
    expect(c).toHaveLength(3);
    expect(c[0]).toMatchObject({ confidence: 1 });
    expect(c[0]!.note.length).toBe(300);
    expect(c[1]).toMatchObject({ check: "labelling", result: "inconclusive", confidence: 0 });
    expect(normaliseChecks([{ check: "spec", result: "consistent", confidence: NaN, note: "" }])[2]!.confidence).toBe(0);
  });
});
