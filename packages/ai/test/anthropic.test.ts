import { describe, expect, it } from "vitest";
import { anthropicProviders } from "../src";
import type { MessagesClient } from "../src/anthropic";

const fake = (impl: (params: Record<string, unknown>) => unknown): MessagesClient =>
  ({ messages: { create: async (p: Record<string, unknown>) => impl(p) } }) as unknown as MessagesClient;
const textResponse = (obj: unknown) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(obj) }] });

const intentInput = {
  title: "x", requirement: "call 9876543210 or a@b.com", buyerVerificationTier: 1, buyerPhoneVerified: true, buyerPriorEnquiries: 0, buyerPriorResponded: 0,
};

describe("anthropic providers", () => {
  it("sends redacted input, uses structured output, validates the result", async () => {
    let sent: Record<string, unknown> = {};
    const p = anthropicProviders(fake((params) => { sent = params; return textResponse({ score: 130.4, reasons: ["ok"], confidence: 0.8 }); }));
    const r = await p.intent.score(intentInput);
    expect(r.provider).toBe("anthropic");
    expect(r.promptVersion).toBe("intent-v1");
    expect(r.output.score).toBe(100); // clamped
    const body = JSON.stringify(sent);
    expect(body).not.toContain("9876543210");
    expect(body).not.toContain("a@b.com");
    expect((sent.output_config as { format: { type: string } }).format.type).toBe("json_schema");
  });

  it("uses temperature 0 on the Haiku moderation tier only", async () => {
    const seen: Record<string, unknown>[] = [];
    const p = anthropicProviders(fake((params) => { seen.push(params); return textResponse({ verdict: "allow", flags: [], reason: null, confidence: 0.9 }); }));
    await p.moderator.moderate({ text: "boxes" });
    expect(seen[0]!.temperature).toBe(0);
    expect(String(seen[0]!.model)).toContain("haiku");
  });

  it("falls back to the heuristic and labels the provider on API error or bad output", async () => {
    const boom = anthropicProviders(fake(() => { throw new Error("timeout"); }));
    const r = await boom.moderator.moderate({ text: "tramadol tablets" });
    expect(r.provider).toBe("heuristic-fallback");
    expect(r.output.verdict).toBe("block");

    const bad = anthropicProviders(fake(() => textResponse({ nonsense: true })));
    expect((await bad.intent.score(intentInput)).provider).toBe("heuristic-fallback");
  });

  it("drops category slugs the model invented", async () => {
    const p = anthropicProviders(fake(() => textResponse({
      title: "Box", description: "d", categorySlug: "made-up", attributes: [{ key: "ply", value: "3" }],
      pricePaise: 520, priceUnit: "piece", moq: 5, moqUnit: "piece", hsn: "12", confidence: 0.9,
    })));
    const r = await p.extractor.extract({ text: "box", language: "en", categories: [{ slug: "boxes", name: "Boxes", attributeSchema: {} }] });
    expect(r.output).toMatchObject({ categorySlug: null, attributes: { ply: 3 }, hsn: null });
  });
});
