import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicDocumentExtractor, anthropicDocumentExtractor, extractDocument, getDocumentExtractor, setDocumentExtractorForTests, REVIEW_THRESHOLDS } from "../src";
import type { MessagesClient } from "../src/anthropic";
import { syntheticPng } from "../evals/fixtures";

const bytes = () => syntheticPng(64, 48, "checker", [200, 30, 30]);
const input = (over = {}) => ({ image: { bytes: bytes(), mimeType: "image/png" }, docType: "pan_card" as const, ...over });
const subject = () => ({ type: "business" as const, id: randomUUID() });
const fake = (impl: (p: any) => unknown): MessagesClient => ({ messages: { create: async (p: any) => impl(p) } }) as unknown as MessagesClient;
const reply = (o: unknown) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(o) }] });
const full = {
  name: " Sharma Steel ", pan: "abcde1234f", gstin: "27ABCDE1234F1Z5", address: "1 MG Road", issueDate: "2020-04-01", udyam: "udyam-mh-01-0000001",
  accountLast4: "0012 3456", ifsc: "hdfc0001234", aadhaarLast4: "x9876", forgerySignals: ["font mismatch", " "], confidence: 0.9,
};

afterEach(() => { vi.restoreAllMocks(); setDocumentExtractorForTests(null); delete process.env.AI_PROVIDER; });

describe("extractDocument", () => {
  it("heuristic: empty fields, low confidence, review queued, log has no bytes", async () => {
    const r = await extractDocument(input(), subject());
    expect(r.fields).toEqual({});
    expect(r.needsReview).toBe(true);
    expect(r.confidence).toBeLessThan(REVIEW_THRESHOLDS.extract_document);
    const d = await prisma.aiDecision.findUniqueOrThrow({ where: { id: r.decisionId } });
    expect(d.capability).toBe("extract_document");
    expect(JSON.stringify(d.inputRedacted)).not.toMatch(/bytes":\{|iVBOR/);
    expect(d.inputRedacted).toMatchObject({ docType: "pan_card", mimeType: "image/png" });
  });

  it("anthropic: normalises fields, redacts PAN/GSTIN/name in the log, forgery signal forces review", async () => {
    let sent: any;
    setDocumentExtractorForTests(new AnthropicDocumentExtractor(fake((p) => { sent = p; return reply(full); })));
    const r = await extractDocument(input(), subject());
    expect(r.fields).toEqual({
      name: "Sharma Steel", pan: "ABCDE1234F", gstin: "27ABCDE1234F1Z5", address: "1 MG Road", issueDate: "2020-04-01", udyam: "UDYAM-MH-01-0000001",
      accountLast4: "3456", ifsc: "HDFC0001234", aadhaarLast4: "9876",
    });
    expect(r.forgerySignals).toEqual(["font mismatch"]);
    expect(r.needsReview).toBe(true);
    expect(sent.messages[0].content[0].type).toBe("image");
    const d = await prisma.aiDecision.findUniqueOrThrow({ where: { id: r.decisionId }, include: { reviews: true } });
    const out = JSON.stringify(d.output);
    expect(out).not.toMatch(/ABCDE1234F|27ABCDE1234F1Z5|Sharma|MG Road/);
    expect(d.reviews[0]!.reason).toMatch(/Possible tampering/);
  });

  it("anthropic: clean high-confidence read is not queued; junk values are dropped", async () => {
    setDocumentExtractorForTests(new AnthropicDocumentExtractor(fake(() => reply({
      name: null, pan: "not a pan", gstin: "bad", address: null, issueDate: "1 Apr", udyam: null, accountLast4: "ab", ifsc: "x", aadhaarLast4: null, forgerySignals: [], confidence: 7,
    }))));
    const r = await extractDocument(input(), subject());
    expect(r.fields).toEqual({});
    expect(r.confidence).toBe(1);
    expect(r.needsReview).toBe(false);
  });

  it("fallback on provider failure; refusal and empty responses throw when fallback is off", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const boom = anthropicDocumentExtractor(fake(() => { throw new Error("down"); }));
    const r = await boom.extract(input());
    expect(r.provider).toBe("heuristic-fallback");
    await expect(anthropicDocumentExtractor(fake(() => { throw new Error("down"); }), false).extract(input())).rejects.toThrow("down");
    await expect(anthropicDocumentExtractor(fake(() => ({ stop_reason: "refusal", content: [] })), false).extract(input())).rejects.toThrow("refused");
    await expect(anthropicDocumentExtractor(fake(() => ({ stop_reason: "end_turn", content: [] })), false).extract(input())).rejects.toThrow("no text block");
  });

  it("getDocumentExtractor follows AI_PROVIDER and caches", async () => {
    expect((await getDocumentExtractor().extract(input())).provider).toBe("heuristic");
    process.env.AI_PROVIDER = "anthropic";
    const a = getDocumentExtractor();
    expect(getDocumentExtractor()).toBe(a);
  });

  it.each([
    ["unknown type", input({ docType: "passport" })],
    ["gif", input({ image: { bytes: bytes(), mimeType: "image/gif" } })],
    ["empty", input({ image: { bytes: new Uint8Array(0), mimeType: "image/png" } })],
    ["mislabeled", input({ image: { bytes: bytes(), mimeType: "image/jpeg" } })],
    ["huge", input({ image: { bytes: new Uint8Array(9 * 1024 * 1024).fill(0xff), mimeType: "image/jpeg" } })],
  ])("rejects %s", async (_n, i) => {
    await expect(extractDocument(i as never, subject())).rejects.toThrow();
  });

  it("accepts jpeg and webp magic bytes", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]);
    const webp = new Uint8Array(16); webp.set([0x52, 0x49, 0x46, 0x46], 0); webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect((await extractDocument({ image: { bytes: jpeg, mimeType: "image/jpeg" }, docType: "gst_certificate" }, subject())).needsReview).toBe(true);
    expect((await extractDocument({ image: { bytes: webp, mimeType: "image/webp" }, docType: "gst_certificate" }, subject())).needsReview).toBe(true);
  });
});
