import { afterEach, describe, expect, it } from "vitest";
import {
  getShadowDispatchInspector, getShadowDocumentExtractor, setShadowDispatchInspectorForTests, setShadowDocumentExtractorForTests,
} from "../src";

const ENV = ["AI_PROVIDER", "AI_SHADOW_PROVIDER", "AI_SHADOW_MODEL_REASONING", "AI_SHADOW_MODEL_FAST"] as const;
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);

afterEach(() => {
  setShadowDocumentExtractorForTests(null);
  setShadowDispatchInspectorForTests(null);
  for (const k of ENV) delete process.env[k];
});

describe("heuristic shadow readers (document, dispatch inspection)", () => {
  it("document: heuristic candidate is cached, reads nothing, and is off when shadow matches live", async () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.AI_SHADOW_PROVIDER = "heuristic";
    const doc = getShadowDocumentExtractor()!;
    expect(doc).not.toBeNull();
    expect(getShadowDocumentExtractor()).toBe(doc);
    const read = await doc.extract({ docType: "pan_card", image: { bytes: png, mimeType: "image/png" } });
    expect(read).toMatchObject({ provider: "heuristic", output: { fields: {}, forgerySignals: [] } });

    process.env.AI_PROVIDER = "heuristic";
    expect(getShadowDocumentExtractor()).toBeNull();
  });

  it("dispatch inspection: heuristic candidate is cached, runs, and is off when shadow matches live", async () => {
    process.env.AI_PROVIDER = "anthropic";
    process.env.AI_SHADOW_PROVIDER = "heuristic";
    const ins = getShadowDispatchInspector()!;
    expect(ins).not.toBeNull();
    expect(getShadowDispatchInspector()).toBe(ins);
    const out = await ins.inspect({
      images: [{ bytes: png, mimeType: "image/png" }],
      expected: { categorySlug: "packaging", productTitle: "Box", quantity: 10, unit: "pcs" },
    } as never);
    expect(out.provider).toBe("heuristic");

    process.env.AI_PROVIDER = "heuristic";
    expect(getShadowDispatchInspector()).toBeNull();
  });
});
