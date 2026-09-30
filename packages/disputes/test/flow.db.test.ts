process.env.DISPUTES_ENABLED = "true";
import { prisma } from "@cnote/db";
import { MemoryJobQueue, setJobQueue, type QueueMessage } from "@cnote/core";
import { setDisputeBriefProviderForTests } from "@cnote/ai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cnote/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cnote/identity")>()),
  getTrustProfiles: async (ids: string[]) => new Map(ids.map((i) => [i, { businessId: i, name: `Biz ${i.slice(0, 4)}` }])),
}));

import {
  adjudicateDispute, advanceDisputes, appealDecision, addDisputeEvidence, collectEvidence, countDisputesNeedingStaff, decideAppeal, disputeMetrics, escalateDispute,
  finalizeAutoResolutions, flagOverdueDisputes, getDispute, getDisputeForOrder, getDisputeForStaff, listDisputeQueue, listDisputes, openDispute, postDisputeMessage,
  purgeResolvedDisputeEvidence, queueBrief, readEvidenceFileForParty, readEvidenceFileForStaff, respondToDispute, runBrief, setEscrowPort, setQualityEvidencePort,
  staffPostDisputeMessage, withdrawDispute, type Actor,
} from "../src";
import { BRIEF_TOPIC, COLLECT_TOPIC } from "../src/jobs";
import { Fixtures, JPEG, PDF, eventsFor, installStore, voice } from "./helpers";

const fx = new Fixtures();
const staffId = "00000000-0000-4000-8000-000000000042";
let queue: MemoryJobQueue;
let store: ReturnType<typeof installStore>;
const escrows = new Map<string, { escrowId: string; status: string; heldPaise: number; invoice?: { number: string; totalPaise: number } | null }>();
const checks = new Map<string, { id: string; verdict: "consistent" | "inconsistent" | "inconclusive"; confidence: number; summary: string }[]>();

beforeAll(() => {
  setEscrowPort({ getEscrowForOrder: async (id) => escrows.get(id) ?? null });
  setQualityEvidencePort({ listChecksForOrder: async (id) => checks.get(id) ?? [] });
});
beforeEach(() => { queue = new MemoryJobQueue(); setJobQueue(queue); store = installStore(); process.env.DISPUTES_ENABLED = "true"; });
afterEach(() => { setDisputeBriefProviderForTests(null); });
afterAll(async () => { setJobQueue(undefined); setEscrowPort(null); setQualityEvidencePort(null); await fx.cleanup(); });

const drain = async <T extends typeof COLLECT_TOPIC | typeof BRIEF_TOPIC>(topic: T) => {
  const seen: QueueMessage<{ disputeId: string }>[] = [];
  await queue.consume(topic, "t", "t", async (m) => { seen.push(m as QueueMessage<{ disputeId: string }>); });
  return seen;
};
const row = (id: string) => prisma.dispute.findUniqueOrThrow({ where: { id } });

/** A damaged-goods dispute with strong corroboration: quantity 20 boxes, Rs 2,000 total: clear, low-value, allow-listed. */
async function strongCase(over: { quantity?: number } = {}) {
  const o = await fx.order({ quantity: over.quantity ?? 20, messages: ["Please pack carefully", "Sure, double wall boxes"] });
  checks.set(o.orderId, [{ id: `qc-${o.orderId}`, verdict: "inconsistent", confidence: 0.9, summary: "crushed corners" }]);
  const d = await openDispute(o.buyer, { orderId: o.orderId, type: "damaged", description: "Cartons arrived crushed and broken, boxes damaged", amountPaise: 100_000 });
  fx.track(d.id);
  await addDisputeEvidence(o.buyer, d.id, { attachment: { kind: "photo", bytes: JPEG, mimeType: "image/jpeg" } });
  await respondToDispute(o.seller, d.id, { text: "Sorry, my mistake, we will replace the damaged boxes" });
  return { o, d };
}

describe("openDispute", () => {
  it("is unavailable while DISPUTES_ENABLED is off", async () => {
    const o = await fx.order();
    process.env.DISPUTES_ENABLED = "false";
    await expect(openDispute(o.buyer, { orderId: o.orderId, type: "damaged", description: "boxes were damaged" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("opens a dispute: 7 day SLA, 72h response window, evidence, DisputeOpened, collection job", async () => {
    const o = await fx.order();
    const before = Date.now();
    const d = await openDispute(o.buyer, { orderId: o.orderId, type: "quality_mismatch", description: "Board is thinner than the agreed 5 ply", amountPaise: 300_000, language: "hi" });
    fx.track(d.id);
    expect(d).toMatchObject({ status: "open", type: "quality_mismatch", role: "buyer", openedByMe: true, amountPaise: 300_000, atStakePaise: o.totalPaise, language: "hi", counterpartyBusinessId: o.seller.businessId });
    expect(Date.parse(d.dueAt) - before).toBeGreaterThan(7 * 86_400_000 - 5_000);
    expect(Date.parse(d.dueAt) - before).toBeLessThan(7 * 86_400_000 + 5_000);
    expect(Date.parse(d.responseDueAt) - before).toBeGreaterThan(72 * 3_600_000 - 5_000);
    expect(d.can).toMatchObject({ respond: false, addEvidence: true, withdraw: true, escalate: false, appeal: false });
    expect(d.evidence).toHaveLength(1);
    expect(d.evidence[0]).toMatchObject({ party: "buyer", kind: "statement", mine: true });
    expect((await row(d.id)).activeOrderId).toBe(o.orderId);
    expect((await eventsFor("DisputeOpened", d.id))[0]!.payload).toEqual({
      disputeId: d.id, orderId: o.orderId, openedByBusinessId: o.buyer.businessId, againstBusinessId: o.seller.businessId, type: "quality_mismatch", amountPaise: 300_000,
    });
    expect((await drain(COLLECT_TOPIC)).map((m) => m.payload.disputeId)).toEqual([d.id]);
  });

  it("lets the seller open one too and shows the counterparty the right role and response action", async () => {
    const o = await fx.order();
    const d = await openDispute(o.seller, { orderId: o.orderId, type: "payment_issue", description: "Buyer has not paid the agreed balance" });
    fx.track(d.id);
    expect(d).toMatchObject({ role: "seller", counterpartyBusinessId: o.buyer.businessId, amountPaise: null });
    const b = (await getDispute(o.buyer, d.id))!;
    expect(b).toMatchObject({ role: "buyer", openedByMe: false });
    expect(b.can).toMatchObject({ respond: true, withdraw: false });
  });

  it("only parties to the order can open; cancelled and unconfirmed orders cannot be disputed", async () => {
    const o = await fx.order();
    const stranger = await fx.party("stranger");
    await expect(openDispute(stranger, { orderId: o.orderId, type: "damaged", description: "boxes were damaged" })).rejects.toMatchObject({ code: "not_found" });
    const cancelled = await fx.order({ status: "cancelled" });
    await expect(openDispute(cancelled.buyer, { orderId: cancelled.orderId, type: "damaged", description: "boxes were damaged" })).rejects.toMatchObject({ code: "conflict" });
    const recorded = await fx.order({ status: "recorded" });
    await expect(openDispute(recorded.buyer, { orderId: recorded.orderId, type: "damaged", description: "boxes were damaged" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("allows only one open dispute per order, including under concurrency, and frees the slot on close", async () => {
    const o = await fx.order();
    const attempt = () => openDispute(o.buyer, { orderId: o.orderId, type: "damaged", description: "boxes were damaged badly" });
    const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "conflict" });
    const first = (ok[0] as PromiseFulfilledResult<{ id: string }>).value;
    fx.track(first.id);
    await expect(attempt()).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("already an open dispute") });
    await withdrawDispute(o.buyer, first.id);
    const again = await attempt();
    fx.track(again.id);
    expect(again.id).not.toBe(first.id);
  });

  it("validates input", async () => {
    const o = await fx.order();
    const base = { orderId: o.orderId, type: "damaged" as const, description: "boxes were damaged" };
    await expect(openDispute(o.buyer, { ...base, orderId: "nope" })).rejects.toMatchObject({ code: "validation" });
    await expect(openDispute(o.buyer, { ...base, type: "bogus" as never })).rejects.toMatchObject({ code: "validation" });
    await expect(openDispute(o.buyer, { ...base, description: "short" })).rejects.toMatchObject({ code: "validation" });
    await expect(openDispute(o.buyer, { ...base, amountPaise: -1 })).rejects.toMatchObject({ code: "validation" });
    await expect(openDispute(o.buyer, { ...base, amountPaise: 1.5 })).rejects.toMatchObject({ code: "validation" });
    await expect(openDispute(o.buyer, { ...base, amountPaise: o.totalPaise + 1 })).rejects.toMatchObject({ code: "validation", message: expect.stringContaining("cannot exceed") });
    expect(await prisma.dispute.count({ where: { orderId: o.orderId } })).toBe(0);
  });

  it("sizes the amount at stake from escrow when there is one, else the order total", async () => {
    const o = await fx.order();
    escrows.set(o.orderId, { escrowId: "esc-1", status: "held", heldPaise: 750_000, invoice: { number: "INV-1", totalPaise: 1_000_000 } });
    const d = await openDispute(o.buyer, { orderId: o.orderId, type: "damaged", description: "boxes were damaged" });
    fx.track(d.id);
    expect(d.atStakePaise).toBe(750_000);
  });

  it("accepts photos and PDFs, stores them under the private disputes/ prefix, and rolls the files back on failure", async () => {
    const o = await fx.order();
    const d = await openDispute(o.buyer, {
      orderId: o.orderId, type: "damaged", description: "boxes were damaged",
      attachments: [{ kind: "photo", bytes: JPEG, mimeType: "image/jpeg" }, { kind: "document", bytes: PDF, mimeType: "application/pdf" }],
    });
    fx.track(d.id);
    expect(d.evidence.map((e) => e.kind).sort()).toEqual(["document", "photo", "statement"]);
    const keys = [...store.files.keys()];
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(k).toMatch(new RegExp(`^disputes/${d.id}/[0-9a-f-]{36}\\.(jpg|pdf)$`));

    store.files.clear();
    const o2 = await fx.order();
    await expect(openDispute(o2.buyer, {
      orderId: o2.orderId, type: "damaged", description: "boxes were damaged", amountPaise: o2.totalPaise * 2, attachments: [{ kind: "photo", bytes: JPEG, mimeType: "image/jpeg" }],
    })).rejects.toMatchObject({ code: "validation" });
    expect(store.files.size).toBe(0);
    await expect(openDispute(o2.buyer, { orderId: o2.orderId, type: "damaged", description: "boxes were damaged", attachments: [{ kind: "photo", bytes: PDF, mimeType: "image/png" }] })).rejects.toMatchObject({ code: "validation" });
    const many = Array.from({ length: 7 }, () => ({ kind: "photo" as const, bytes: JPEG, mimeType: "image/jpeg" }));
    await expect(openDispute(o2.buyer, { orderId: o2.orderId, type: "damaged", description: "boxes were damaged", attachments: many })).rejects.toMatchObject({ message: expect.stringContaining("at most") });
  });

  it("takes a voice note: needs consent, is transcribed and becomes the description when none is typed", async () => {
    const o = await fx.order();
    const att = [{ kind: "voice" as const, bytes: voice("माल टूटा हुआ आया, आधे डिब्बे खराब हैं"), mimeType: "audio/ogg" }];
    await expect(openDispute(o.buyer, { orderId: o.orderId, type: "damaged", language: "hi", attachments: att })).rejects.toMatchObject({ message: expect.stringContaining("consent") });
    expect(store.files.size).toBe(0);
    const d = await openDispute(o.buyer, { orderId: o.orderId, type: "damaged", language: "hi", voiceConsent: true, attachments: att });
    fx.track(d.id);
    expect(d.description).toContain("माल टूटा");
    expect(d.evidence).toHaveLength(1);
    expect(d.evidence[0]).toMatchObject({ kind: "voice", hasFile: true, mimeType: "audio/ogg" });
    expect(d.evidence[0]!.text).toContain("माल टूटा");
    // an empty transcript and no text: nothing to go on
    const o2 = await fx.order();
    await expect(openDispute(o2.buyer, { orderId: o2.orderId, type: "damaged", voiceConsent: true, attachments: [{ kind: "voice", bytes: new TextEncoder().encode("noise"), mimeType: "audio/ogg" }] })).rejects.toMatchObject({ code: "validation" });
    expect(store.files.size).toBe(1); // only the first dispute's file remains
  });
});

describe("evidence collection", () => {
  it("attaches order, quote, conversation, escrow, invoice and quality evidence from public functions/ports, idempotently", async () => {
    const o = await fx.order({ messages: ["Need 100 boxes by Friday", "Confirmed, will ship Monday"] });
    escrows.set(o.orderId, { escrowId: "esc-2", status: "held", heldPaise: o.totalPaise, invoice: { number: "INV-77", totalPaise: o.totalPaise } });
    checks.set(o.orderId, [{ id: "qc-1", verdict: "inconsistent", confidence: 0.8, summary: "label missing" }]);
    const d = await openDispute(o.buyer, { orderId: o.orderId, type: "quality_mismatch", description: "Label is missing on cartons" });
    fx.track(d.id);
    expect(await collectEvidence(d.id)).toBe(6);
    expect(await collectEvidence(d.id)).toBe(0);
    const rows = await prisma.disputeEvidence.findMany({ where: { disputeId: d.id, party: "system" } });
    expect(rows.map((r) => r.source).sort()).toEqual(["auto:escrow", "auto:invoice", "auto:messages", "auto:order", "auto:quality", "auto:quote"]);
    const msgs = rows.find((r) => r.source === "auto:messages")!.text!;
    expect(msgs).toContain("Buyer: Need 100 boxes by Friday");
    expect(msgs).toContain("Seller: Confirmed, will ship Monday");
    expect(rows.find((r) => r.source === "auto:order")!.text).toContain("Buyer marked the order delivered.");
    expect(rows.find((r) => r.source === "auto:quote")!.text).toContain("100 box");
    expect(rows.find((r) => r.source === "auto:invoice")!.text).toContain("INV-77");
    escrows.delete(o.orderId); checks.delete(o.orderId);
  });

  it("does nothing for closed or unknown disputes and states lifecycle facts per order status", async () => {
    expect(await collectEvidence("00000000-0000-4000-8000-000000000001")).toBe(0);
    const confirmed = await fx.order({ status: "confirmed", withQuote: false });
    const d = await openDispute(confirmed.buyer, { orderId: confirmed.orderId, type: "non_delivery", description: "Nothing has arrived at all" });
    fx.track(d.id);
    await collectEvidence(d.id);
    expect((await prisma.disputeEvidence.findFirstOrThrow({ where: { disputeId: d.id, source: "auto:order" } })).text).toContain("Seller never marked the order dispatched.");
    const dispatched = await fx.order({ status: "dispatched" });
    const d2 = await openDispute(dispatched.seller, { orderId: dispatched.orderId, type: "payment_issue", description: "The buyer has not paid us yet" });
    fx.track(d2.id);
    await collectEvidence(d2.id);
    expect((await prisma.disputeEvidence.findFirstOrThrow({ where: { disputeId: d2.id, source: "auto:order" } })).text).toContain("has not marked it delivered");
    await withdrawDispute(dispatched.seller, d2.id);
    expect(await collectEvidence(d2.id)).toBe(0);
  });
});

describe("respond and add evidence", () => {
  it("only the counterparty responds; the response closes the window early and queues the brief once", async () => {
    const o = await fx.order();
    const d = await openDispute(o.buyer, { orderId: o.orderId, type: "damaged", description: "boxes were damaged" });
    fx.track(d.id);
    await expect(respondToDispute(o.buyer, d.id, { text: "my own dispute" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(respondToDispute(o.seller, d.id, {})).rejects.toMatchObject({ code: "validation" });
    await expect(respondToDispute(o.seller, d.id, { attachments: [{ kind: "photo", bytes: JPEG, mimeType: "image/jpeg" }] })).rejects.toMatchObject({ message: expect.stringContaining("statement") });
    const stranger = await fx.party("x");
    await expect(respondToDispute(stranger, d.id, { text: "hello there" })).rejects.toMatchObject({ code: "not_found" });
    const ev = await respondToDispute(o.seller, d.id, { text: "We packed them properly", language: "en" });
    expect(ev[0]).toMatchObject({ party: "seller", mine: true, kind: "statement" });
    const cur = await row(d.id);
    expect(cur.status).toBe("evidence");
    expect(cur.counterpartyRespondedAt).not.toBeNull();
    expect((await drain(BRIEF_TOPIC)).map((m) => m.payload.disputeId)).toEqual([d.id]);
    // a second statement adds evidence but does not re-queue
    await addDisputeEvidence(o.seller, d.id, { text: "Photo of packing", attachment: { kind: "photo", bytes: JPEG, mimeType: "image/jpeg" } });
    expect(await drain(BRIEF_TOPIC)).toHaveLength(0);
    const v = (await getDispute(o.buyer, d.id))!;
    expect(v.can).toMatchObject({ respond: false, addEvidence: true });
    expect(v.evidence.filter((e) => e.party === "seller")).toHaveLength(3);
    expect(v.evidence.filter((e) => e.party === "seller").every((e) => !e.mine)).toBe(true);
  });

  it("closes evidence once the case is briefed and enforces per-party limits and content rules", async () => {
    const o = await fx.order();
    const d = await openDispute(o.buyer, { orderId: o.orderId, type: "damaged", description: "boxes were damaged" });
    fx.track(d.id);
    await expect(addDisputeEvidence(o.buyer, d.id, {})).rejects.toMatchObject({ code: "validation" });
    await expect(addDisputeEvidence(o.buyer, d.id, { text: "x".repeat(4001) })).rejects.toMatchObject({ code: "validation" });
    await prisma.disputeEvidence.createMany({ data: Array.from({ length: 29 }, () => ({ disputeId: d.id, party: "buyer" as const, submittedByBusinessId: o.buyer.businessId, kind: "statement" as const, text: "more" })) });
    await expect(addDisputeEvidence(o.buyer, d.id, { text: "one more" })).rejects.toMatchObject({ message: expect.stringContaining("limit") });
    await prisma.dispute.update({ where: { id: d.id }, data: { status: "awaiting_adjudication" } });
    await expect(addDisputeEvidence(o.buyer, d.id, { text: "too late" })).rejects.toMatchObject({ code: "conflict" });
    await expect(respondToDispute(o.seller, d.id, { text: "too late" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("accepts a voice response (consent required) whose transcript is the statement", async () => {
    const o = await fx.order();
    const d = await openDispute(o.buyer, { orderId: o.orderId, type: "damaged", description: "boxes were damaged" });
    fx.track(d.id);
    const att = [{ kind: "voice" as const, bytes: voice("hum ne theek se pack kiya tha"), mimeType: "audio/mpeg" }];
    await expect(respondToDispute(o.seller, d.id, { attachments: att })).rejects.toMatchObject({ message: expect.stringContaining("consent") });
    const ev = await respondToDispute(o.seller, d.id, { voiceConsent: true, language: "hi", attachments: att });
    expect(ev[0]).toMatchObject({ kind: "voice", text: "hum ne theek se pack kiya tha" });
  });
});

describe("AI brief and routing", () => {
  it("briefs a clear low-value case and proposes an automatic resolution with an escalation window", async () => {
    const { o, d } = await strongCase();
    expect(await runBrief(d.id)).toBe("briefed");
    const cur = await row(d.id);
    expect(cur.status).toBe("auto_resolved");
    expect(cur.proposedOutcome).toBe("buyer_favour");
    expect(cur.proposedRefundPaise).toBe(BigInt(o.totalPaise));
    expect(cur.proposedReleasePaise).toBe(0n);
    expect(cur.proposedFaultBusinessId).toBe(o.seller.businessId);
    const hours = (cur.escalationDeadline!.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47.9);
    expect(hours).toBeLessThan(48.1);
    const brief = await prisma.disputeBrief.findFirstOrThrow({ where: { disputeId: d.id } });
    expect(brief).toMatchObject({ version: 1, classifiedType: "damaged", recommendedOutcome: "buyer_favour", autoResolvable: true, needsReview: false, provider: "heuristic", modelId: "heuristic-dispute-v1" });
    expect(brief.confidence).toBeGreaterThanOrEqual(0.85);
    expect((brief.citedEvidenceIds as string[]).length).toBeGreaterThanOrEqual(3);
    expect(brief.aiDecisionId).not.toBeNull();
    const ev = (await eventsFor("DisputeBriefReady", d.id))[0]!.payload;
    expect(ev).toMatchObject({ disputeId: d.id, orderId: o.orderId, recommendation: "buyer_favour", autoResolvable: true });
    const view = (await getDispute(o.seller, d.id))!;
    expect(view.proposal).toMatchObject({ outcome: "buyer_favour", refundPaise: o.totalPaise, releasePaise: 0 });
    expect(view.can.escalate).toBe(true);
    expect(view.decision).toBeNull();
  });

  it("sends anything else to a human: high value, off-allowlist type, or low confidence", async () => {
    const big = await strongCase({ quantity: 200 }); // Rs 20,000 > Rs 5,000
    await runBrief(big.d.id);
    expect((await row(big.d.id)).status).toBe("awaiting_adjudication");
    expect((await prisma.disputeBrief.findFirstOrThrow({ where: { disputeId: big.d.id } })).autoResolvable).toBe(false);

    const o = await fx.order({ quantity: 20 });
    const nd = await openDispute(o.buyer, { orderId: o.orderId, type: "non_delivery", description: "Nothing has arrived, never received" });
    fx.track(nd.id);
    await respondToDispute(o.seller, nd.id, { text: "Delivered on 3 March, signed by store keeper, tracking number 55" });
    await runBrief(nd.id);
    expect((await row(nd.id)).status).toBe("awaiting_adjudication");

    const thin = await fx.order({ quantity: 20 });
    const t = await openDispute(thin.buyer, { orderId: thin.orderId, type: "other", description: "Not happy with the whole thing" });
    fx.track(t.id);
    await queueBrief(t.id);
    await runBrief(t.id);
    expect((await row(t.id)).status).toBe("awaiting_adjudication");
    const b = await prisma.disputeBrief.findFirstOrThrow({ where: { disputeId: t.id } });
    expect(b.needsReview).toBe(true);
    expect(await prisma.reviewItem.count({ where: { aiDecisionId: b.aiDecisionId!, status: "open" } })).toBe(1);
  });

  it("is idempotent, skips closed cases and lets provider errors propagate for queue retry", async () => {
    const { d } = await strongCase();
    setDisputeBriefProviderForTests({ brief: async () => { throw new Error("vendor down"); } });
    await expect(runBrief(d.id)).rejects.toThrow("vendor down");
    expect((await row(d.id)).status).toBe("evidence");
    expect(await prisma.disputeBrief.count({ where: { disputeId: d.id } })).toBe(0);
    setDisputeBriefProviderForTests(null);
    expect(await runBrief(d.id)).toBe("briefed");
    expect(await runBrief(d.id)).toBe("skipped");
    expect(await prisma.disputeBrief.count({ where: { disputeId: d.id } })).toBe(1);
    expect(await runBrief("00000000-0000-4000-8000-000000000001")).toBe("skipped");
  });

  it("does not overwrite a case withdrawn while the brief was being written", async () => {
    const { o, d } = await strongCase();
    setDisputeBriefProviderForTests({
      brief: async (input) => {
        await withdrawDispute(o.buyer, d.id);
        const { briefDisputeHeuristic } = await import("@cnote/ai");
        return briefDisputeHeuristic(input);
      },
    });
    await runBrief(d.id);
    expect((await row(d.id)).status).toBe("withdrawn");
    expect(await prisma.disputeBrief.count({ where: { disputeId: d.id } })).toBe(0);
  });

  it("queueBrief only moves an open case, once", async () => {
    const o = await fx.order();
    const d = await openDispute(o.buyer, { orderId: o.orderId, type: "damaged", description: "boxes were damaged" });
    fx.track(d.id);
    expect(await queueBrief(d.id)).toBe(true);
    expect(await queueBrief(d.id)).toBe(false);
    expect(await queueBrief("00000000-0000-4000-8000-000000000001")).toBe(false);
    expect((await drain(BRIEF_TOPIC)).length).toBe(1);
  });
});

describe("escalation and auto-resolution", () => {
  it("either party can escalate inside the window; the case then waits for a human", async () => {
    const { o, d } = await strongCase();
    await runBrief(d.id);
    const stranger = await fx.party("s");
    await expect(escalateDispute(stranger, d.id)).rejects.toMatchObject({ code: "not_found" });
    await escalateDispute(o.seller, d.id);
    const cur = await row(d.id);
    expect(cur).toMatchObject({ status: "awaiting_adjudication", escalatedByBusinessId: o.seller.businessId });
    expect((await eventsFor("DisputeEscalated", d.id))[0]!.payload).toEqual({ disputeId: d.id, orderId: o.orderId, byBusinessId: o.seller.businessId });
    await expect(escalateDispute(o.buyer, d.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses escalation after the window and for cases that were never auto-resolved", async () => {
    const { o, d } = await strongCase();
    await expect(escalateDispute(o.buyer, d.id)).rejects.toMatchObject({ code: "conflict" }); // still collecting evidence
    await runBrief(d.id);
    await prisma.dispute.update({ where: { id: d.id }, data: { escalationDeadline: new Date(Date.now() - 1000) } });
    await expect(escalateDispute(o.buyer, d.id)).rejects.toMatchObject({ message: expect.stringContaining("closed") });
    expect((await getDispute(o.buyer, d.id))!.can.escalate).toBe(false);
  });

  it("finalises an auto-resolution only after the window: decision, DisputeResolved, slot freed, outcome labelled", async () => {
    await finalizeAutoResolutions(); // flush cases other tests left with a closed window
    const { o, d } = await strongCase();
    await runBrief(d.id);
    expect(await finalizeAutoResolutions()).toBe(0); // window still open
    expect((await row(d.id)).status).toBe("auto_resolved");
    await prisma.dispute.update({ where: { id: d.id }, data: { escalationDeadline: new Date(Date.now() - 1000) } });
    expect(await finalizeAutoResolutions()).toBeGreaterThanOrEqual(1);
    expect(await finalizeAutoResolutions()).toBe(0);
    const cur = await row(d.id);
    expect(cur.status).toBe("resolved");
    expect(cur.activeOrderId).toBeNull();
    expect(cur.resolvedAt).not.toBeNull();
    const dec = await prisma.disputeDecision.findUniqueOrThrow({ where: { disputeId: d.id } });
    expect(dec).toMatchObject({ outcome: "buyer_favour", decidedBy: "auto", followedRecommendation: true, faultBusinessId: o.seller.businessId, decidedByStaffPersonId: null });
    const evs = await eventsFor("DisputeResolved", d.id);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toEqual({ disputeId: d.id, orderId: o.orderId, outcome: "buyer_favour", refundPaise: o.totalPaise, releasePaise: 0, decidedBy: "auto", faultBusinessId: o.seller.businessId });
    const label = await prisma.aiDecision.findFirstOrThrow({ where: { subjectId: d.id, capability: "dispute_outcome_label" } });
    expect(label.output).toMatchObject({ recommended: "buyer_favour", final: "buyer_favour", agreed: true, faultRole: "seller" });
    const v = (await getDispute(o.buyer, d.id))!;
    expect(v.decision).toMatchObject({ outcome: "buyer_favour", decidedBy: "auto" });
    expect(v.can.appeal).toBe(true);
    expect(v.proposal).toBeNull();
    // the order can be disputed again once closed
    const again = await openDispute(o.buyer, { orderId: o.orderId, type: "wrong_item", description: "Replacement was the wrong item" });
    fx.track(again.id);
  });
});

describe("adjudication", () => {
  async function awaiting(quantity = 200) {
    const s = await strongCase({ quantity });
    await runBrief(s.d.id);
    expect((await row(s.d.id)).status).toBe("awaiting_adjudication");
    return s;
  }

  it("accepts the AI recommendation verbatim", async () => {
    const { o, d } = await awaiting();
    await adjudicateDispute(staffId, d.id, { outcome: "split", rationale: "Accepting the brief as written", acceptRecommendation: true });
    const dec = await prisma.disputeDecision.findUniqueOrThrow({ where: { disputeId: d.id } });
    expect(dec).toMatchObject({ outcome: "buyer_favour", decidedBy: "staff", decidedByStaffPersonId: staffId, followedRecommendation: true, refundPaise: BigInt(o.totalPaise) });
    expect((await eventsFor("DisputeResolved", d.id))[0]!.payload).toMatchObject({ decidedBy: "staff", faultBusinessId: o.seller.businessId, refundPaise: o.totalPaise, releasePaise: 0 });
  });

  it("records a modified split decision (release is the remainder) and flags that it departs from the brief", async () => {
    const { o, d } = await awaiting();
    await adjudicateDispute(staffId, d.id, { outcome: "split", refundPaise: 500_000, rationale: "Half the boxes were usable" });
    const dec = await prisma.disputeDecision.findUniqueOrThrow({ where: { disputeId: d.id } });
    expect(dec).toMatchObject({ outcome: "split", refundPaise: 500_000n, releasePaise: BigInt(o.totalPaise - 500_000), followedRecommendation: false, faultBusinessId: null });
    const label = await prisma.aiDecision.findFirstOrThrow({ where: { subjectId: d.id, capability: "dispute_outcome_label" } });
    expect(label.output).toMatchObject({ recommended: "buyer_favour", final: "split", agreed: false });
  });

  it("supports full outcomes without amounts, and rejects bad numbers, thin reasons and wrong states", async () => {
    const { d } = await awaiting();
    await expect(adjudicateDispute(staffId, d.id, { outcome: "split", rationale: "no amount given here" })).rejects.toMatchObject({ code: "validation" });
    await expect(adjudicateDispute(staffId, d.id, { outcome: "split", refundPaise: 100, releasePaise: 100, rationale: "amounts do not add up" })).rejects.toMatchObject({ code: "validation" });
    await expect(adjudicateDispute(staffId, d.id, { outcome: "buyer_favour", refundPaise: 5, releasePaise: 1, rationale: "contradictory amounts" })).rejects.toMatchObject({ code: "validation" });
    await expect(adjudicateDispute(staffId, d.id, { outcome: "buyer_favour", rationale: "short" })).rejects.toMatchObject({ code: "validation" });
    await expect(adjudicateDispute(staffId, "bad-id", { outcome: "buyer_favour", rationale: "a valid reason here" })).rejects.toMatchObject({ code: "not_found" });
    await expect(adjudicateDispute(staffId, "00000000-0000-4000-8000-000000000001", { outcome: "buyer_favour", rationale: "a valid reason here" })).rejects.toMatchObject({ code: "not_found" });
    await adjudicateDispute(staffId, d.id, { outcome: "seller_favour", rationale: "Seller proved delivery in good order" });
    expect(await prisma.disputeDecision.findUniqueOrThrow({ where: { disputeId: d.id } })).toMatchObject({ outcome: "seller_favour", refundPaise: 0n });
    await expect(adjudicateDispute(staffId, d.id, { outcome: "buyer_favour", rationale: "second decision attempt" })).rejects.toMatchObject({ code: "conflict" });
    expect(await eventsFor("DisputeResolved", d.id)).toHaveLength(1);
  });

  it("cannot accept a recommendation that does not exist yet, and cannot pre-empt a pending auto-resolution", async () => {
    const o = await fx.order();
    const d = await openDispute(o.buyer, { orderId: o.orderId, type: "damaged", description: "boxes were damaged" });
    fx.track(d.id);
    await expect(adjudicateDispute(staffId, d.id, { outcome: "split", rationale: "accept the missing brief", acceptRecommendation: true })).rejects.toMatchObject({ code: "conflict" }); // still open
    await queueBrief(d.id);
    await expect(adjudicateDispute(staffId, d.id, { outcome: "split", rationale: "accept the missing brief", acceptRecommendation: true })).rejects.toMatchObject({ message: expect.stringContaining("no AI brief") });
    const s = await strongCase();
    await runBrief(s.d.id);
    await expect(adjudicateDispute(staffId, s.d.id, { outcome: "buyer_favour", rationale: "trying to pre-empt auto" })).rejects.toMatchObject({ message: expect.stringContaining("automatic resolution is pending") });
  });

  it("decides an escalated auto-resolution", async () => {
    const { o, d } = await strongCase();
    await runBrief(d.id);
    await escalateDispute(o.buyer, d.id);
    await adjudicateDispute(staffId, d.id, { outcome: "seller_favour", rationale: "Photos show damage after delivery" });
    expect((await row(d.id)).status).toBe("resolved");
  });
});

describe("withdraw", () => {
  it("only the opener can withdraw; emits a withdrawn resolution with nothing to move", async () => {
    const o = await fx.order();
    const d = await openDispute(o.buyer, { orderId: o.orderId, type: "damaged", description: "boxes were damaged" });
    fx.track(d.id);
    await expect(withdrawDispute(o.seller, d.id)).rejects.toMatchObject({ code: "forbidden" });
    await withdrawDispute(o.buyer, d.id);
    const cur = await row(d.id);
    expect(cur).toMatchObject({ status: "withdrawn", activeOrderId: null });
    expect((await eventsFor("DisputeResolved", d.id))[0]!.payload).toEqual({ disputeId: d.id, orderId: o.orderId, outcome: "withdrawn", refundPaise: 0, releasePaise: 0, decidedBy: "auto", faultBusinessId: null });
    await expect(withdrawDispute(o.buyer, d.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(appealDecision(o.buyer, d.id, "I want this looked at again")).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("appeals and messages", () => {
  async function resolved() {
    const { o, d } = await strongCase({ quantity: 200 });
    await runBrief(d.id);
    await adjudicateDispute(staffId, d.id, { outcome: "buyer_favour", rationale: "Photos and seller admission agree" });
    return { o, d };
  }

  it("either party may appeal once within 7 days; staff uphold or modify", async () => {
    const { o, d } = await resolved();
    await expect(appealDecision(o.seller, d.id, "short")).rejects.toMatchObject({ code: "validation" });
    const a = await appealDecision(o.seller, d.id, "The buyer's photos are from a different shipment");
    expect(a).toMatchObject({ status: "open" });
    await expect(appealDecision(o.seller, d.id, "Trying again for good measure")).rejects.toMatchObject({ message: expect.stringContaining("already appealed") });
    const stranger = await fx.party("x");
    await expect(appealDecision(stranger, d.id, "I am not a party at all here")).rejects.toMatchObject({ code: "not_found" });
    expect((await getDispute(o.seller, d.id))!.appeal).toMatchObject({ id: a.id, status: "open" });
    expect(await countDisputesNeedingStaff()).toBeGreaterThanOrEqual(1);
    await expect(decideAppeal(staffId, a.id, { status: "modified", note: "Modify but no numbers here" })).rejects.toMatchObject({ code: "validation" });
    await expect(decideAppeal(staffId, a.id, { status: "modified", note: "Modified split with bad total", newOutcome: "split", newRefundPaise: 1, newReleasePaise: 1 })).rejects.toMatchObject({ code: "validation" });
    await decideAppeal(staffId, a.id, { status: "modified", note: "Half refund on reflection", newOutcome: "split", newRefundPaise: 1_000_000, newReleasePaise: o.totalPaise - 1_000_000 });
    const rec = await prisma.disputeAppeal.findUniqueOrThrow({ where: { id: a.id } });
    expect(rec).toMatchObject({ status: "modified", newOutcome: "split", decidedByStaffPersonId: staffId });
    await expect(decideAppeal(staffId, a.id, { status: "upheld", note: "second decision is refused" })).rejects.toMatchObject({ code: "conflict" });
    await expect(decideAppeal(staffId, "bad", { status: "upheld", note: "not a valid appeal id" })).rejects.toMatchObject({ code: "not_found" });
    await expect(decideAppeal(staffId, "00000000-0000-4000-8000-000000000001", { status: "upheld", note: "no such appeal id" })).rejects.toMatchObject({ code: "not_found" });
    await expect(decideAppeal(staffId, a.id, { status: "upheld", note: "x" })).rejects.toMatchObject({ code: "validation" });
    const b = await appealDecision(o.buyer, d.id, "I would like the amount reviewed");
    await decideAppeal(staffId, b.id, { status: "upheld", note: "Original decision stands" });
    expect((await getDispute(o.buyer, d.id))!.appeal).toMatchObject({ status: "upheld", resolutionNote: "Original decision stands" });
    expect(await eventsFor("DisputeResolved", d.id)).toHaveLength(1); // appeals never re-emit
  });

  it("closes the appeal window after 7 days and refuses undecided cases", async () => {
    const { o, d } = await resolved();
    await prisma.dispute.update({ where: { id: d.id }, data: { resolvedAt: new Date(Date.now() - 8 * 86_400_000) } });
    await expect(appealDecision(o.buyer, d.id, "Sorry this is a bit late really")).rejects.toMatchObject({ message: expect.stringContaining("within 7 days") });
    expect((await getDispute(o.buyer, d.id))!.can.appeal).toBe(false);
    const open = await fx.order();
    const od = await openDispute(open.buyer, { orderId: open.orderId, type: "damaged", description: "boxes were damaged" });
    fx.track(od.id);
    await expect(appealDecision(open.buyer, od.id, "Appealing something undecided")).rejects.toMatchObject({ code: "conflict" });
  });

  it("keeps each party's thread with staff private", async () => {
    const { o, d } = await resolved();
    const stranger = await fx.party("x");
    await expect(postDisputeMessage(o.buyer, d.id, "  ")).rejects.toMatchObject({ code: "validation" });
    await expect(postDisputeMessage(stranger, d.id, "hello")).rejects.toMatchObject({ code: "not_found" });
    await postDisputeMessage(o.buyer, d.id, "Please check invoice 12");
    await staffPostDisputeMessage(staffId, d.id, o.buyer.businessId, "Thanks, we are checking");
    await staffPostDisputeMessage(staffId, d.id, o.seller.businessId, "Please share the dispatch proof");
    await expect(staffPostDisputeMessage(staffId, d.id, stranger.businessId, "hi")).rejects.toMatchObject({ code: "not_found" });
    await expect(staffPostDisputeMessage(staffId, d.id, o.buyer.businessId, "")).rejects.toMatchObject({ code: "validation" });
    await expect(staffPostDisputeMessage(staffId, "bad", o.buyer.businessId, "hi")).rejects.toMatchObject({ code: "not_found" });
    const b = (await getDispute(o.buyer, d.id))!;
    const s = (await getDispute(o.seller, d.id))!;
    expect(b.messages.map((m) => m.body)).toEqual(["Please check invoice 12", "Thanks, we are checking"]);
    expect(b.messages.map((m) => m.mine)).toEqual([true, false]);
    expect(s.messages.map((m) => m.body)).toEqual(["Please share the dispatch proof"]);
    const staff = (await getDisputeForStaff(d.id))!;
    expect(staff.threads).toHaveLength(2);
  });
});

describe("reads", () => {
  it("hides disputes from non-parties and lists mine with the action flag", async () => {
    const o = await fx.order();
    const d = await openDispute(o.buyer, { orderId: o.orderId, type: "damaged", description: "boxes were damaged" });
    fx.track(d.id);
    const stranger = await fx.party("x");
    expect(await getDispute(stranger, d.id)).toBeNull();
    expect(await getDispute(o.buyer, "nope")).toBeNull();
    expect(await getDisputeForOrder(stranger, o.orderId)).toBeNull();
    expect(await getDisputeForOrder(o.buyer, "nope")).toBeNull();
    expect(await getDisputeForOrder(o.buyer, o.orderId)).toMatchObject({ id: d.id, needsMyAction: false });
    expect(await getDisputeForOrder(o.seller, o.orderId)).toMatchObject({ id: d.id, needsMyAction: true, role: "seller", openedByMe: false });
    expect((await listDisputes(o.seller)).map((x) => x.id)).toEqual([d.id]);
    expect(await listDisputes(stranger)).toEqual([]);
  });

  it("serves evidence files to parties and staff only, and never after purge", async () => {
    const o = await fx.order();
    const d = await openDispute(o.buyer, { orderId: o.orderId, type: "damaged", description: "boxes were damaged", attachments: [{ kind: "photo", bytes: JPEG, mimeType: "image/jpeg" }] });
    fx.track(d.id);
    const photo = d.evidence.find((e) => e.kind === "photo")!;
    const stranger = await fx.party("x");
    expect((await readEvidenceFileForParty(o.seller, d.id, photo.id))!.contentType).toBe("image/jpeg");
    expect(await readEvidenceFileForParty(stranger, d.id, photo.id)).toBeNull();
    expect(await readEvidenceFileForParty(o.buyer, d.id, d.evidence.find((e) => e.kind === "statement")!.id)).toBeNull(); // no file
    expect(await readEvidenceFileForParty(o.buyer, "bad", photo.id)).toBeNull();
    expect(await readEvidenceFileForParty(o.buyer, d.id, "bad")).toBeNull();
    expect((await readEvidenceFileForStaff(d.id, photo.id))!.bytes.length).toBe(JPEG.length);
    expect(await readEvidenceFileForStaff("bad", photo.id)).toBeNull();
    expect(await readEvidenceFileForStaff(d.id, "00000000-0000-4000-8000-000000000001")).toBeNull();
  });

  it("gives staff the queue (active first, soonest SLA first), full detail and evidence added after the brief", async () => {
    const a = await strongCase({ quantity: 200 });
    await runBrief(a.d.id);
    const b = await fx.order();
    const bd = await openDispute(b.buyer, { orderId: b.orderId, type: "damaged", description: "boxes were damaged" });
    fx.track(bd.id);
    await prisma.dispute.update({ where: { id: bd.id }, data: { dueAt: new Date(Date.now() - 3_600_000) } }); // overdue
    const c = await strongCase({ quantity: 200 });
    await runBrief(c.d.id);
    await adjudicateDispute(staffId, c.d.id, { outcome: "buyer_favour", rationale: "Clear evidence for the buyer" });

    const queue1 = (await listDisputeQueue({ limit: 300 })).filter((q) => [a.d.id, bd.id, c.d.id].includes(q.id));
    expect(queue1.map((q) => q.id)).toEqual([bd.id, a.d.id, c.d.id]); // overdue, then due later, then closed
    expect(queue1[0]).toMatchObject({ overdue: true });
    expect(queue1[1]).toMatchObject({ overdue: false, status: "awaiting_adjudication" });
    expect(queue1[1]!.briefConfidence).toBeGreaterThan(0.5);
    const active = await listDisputeQueue({ onlyActive: true, limit: 300 });
    expect(active.some((q) => q.id === c.d.id)).toBe(false);
    const filtered = await listDisputeQueue({ status: "resolved", limit: 300 });
    expect(filtered.every((q) => q.status === "resolved")).toBe(true);

    const detail = (await getDisputeForStaff(a.d.id))!;
    expect(detail).toMatchObject({ id: a.d.id, buyerBusinessId: a.o.buyer.businessId, sellerBusinessId: a.o.seller.businessId, evidenceAfterBrief: 0 });
    expect(detail.briefs).toHaveLength(1);
    expect(detail.briefs[0]!.specChecks.length).toBeGreaterThan(0);
    expect(detail.evidence.some((e) => e.party === "system")).toBe(true);
    await prisma.disputeEvidence.create({ data: { disputeId: a.d.id, party: "buyer", kind: "statement", text: "late addition", submittedByBusinessId: a.o.buyer.businessId } });
    expect((await getDisputeForStaff(a.d.id))!.evidenceAfterBrief).toBe(1);
    expect((await getDisputeForStaff(c.d.id))!.decision).toMatchObject({ outcome: "buyer_favour", decidedByStaffPersonId: staffId, followedRecommendation: true });
    expect(await getDisputeForStaff("bad")).toBeNull();
    expect(await getDisputeForStaff("00000000-0000-4000-8000-000000000001")).toBeNull();
  });
});

describe("SLA, scheduled advance and metrics", () => {
  it("flags overdue cases once", async () => {
    const o = await fx.order();
    const d = await openDispute(o.buyer, { orderId: o.orderId, type: "damaged", description: "boxes were damaged" });
    fx.track(d.id);
    expect(await flagOverdueDisputes()).toBeGreaterThanOrEqual(0);
    await prisma.dispute.update({ where: { id: d.id }, data: { dueAt: new Date(Date.now() - 1000), overdueFlaggedAt: null } });
    expect(await flagOverdueDisputes()).toBeGreaterThanOrEqual(1);
    expect((await row(d.id)).overdueFlaggedAt).not.toBeNull();
    expect(await flagOverdueDisputes()).toBe(0);
  });

  it("advance: closes the response window into a brief, requeues lost jobs, finalises auto-resolutions", async () => {
    const o = await fx.order();
    const d = await openDispute(o.buyer, { orderId: o.orderId, type: "damaged", description: "boxes were damaged" });
    fx.track(d.id);
    await drain(COLLECT_TOPIC);
    // window still open, order evidence present -> nothing to do for it
    await collectEvidence(d.id);
    let r = await advanceDisputes();
    expect((await row(d.id)).status).toBe("open");
    // lost collect job: no auto evidence after a minute -> re-enqueued
    const lost = await fx.order();
    const ld = await openDispute(lost.buyer, { orderId: lost.orderId, type: "damaged", description: "boxes were damaged" });
    fx.track(ld.id);
    await drain(COLLECT_TOPIC);
    await prisma.dispute.update({ where: { id: ld.id }, data: { createdAt: new Date(Date.now() - 5 * 60_000) } });
    r = await advanceDisputes();
    expect(r.requeued).toBeGreaterThanOrEqual(1);
    expect((await drain(COLLECT_TOPIC)).map((m) => m.payload.disputeId)).toContain(ld.id);
    // response window closes
    await prisma.dispute.update({ where: { id: d.id }, data: { responseDueAt: new Date(Date.now() - 1000) } });
    r = await advanceDisputes();
    expect(r.briefed).toBeGreaterThanOrEqual(1);
    expect((await row(d.id)).status).toBe("evidence");
    expect((await drain(BRIEF_TOPIC)).map((m) => m.payload.disputeId)).toContain(d.id);
    // stuck brief: queued 40 minutes ago, no result
    await prisma.dispute.update({ where: { id: d.id }, data: { briefQueuedAt: new Date(Date.now() - 40 * 60_000) } });
    r = await advanceDisputes();
    expect(r.requeued).toBeGreaterThanOrEqual(1);
    expect((await drain(BRIEF_TOPIC)).map((m) => m.payload.disputeId)).toContain(d.id);
    // auto-resolution whose window closed
    const s = await strongCase();
    await runBrief(s.d.id);
    await prisma.dispute.update({ where: { id: s.d.id }, data: { escalationDeadline: new Date(Date.now() - 1000) } });
    r = await advanceDisputes();
    expect(r.autoResolved).toBeGreaterThanOrEqual(1);
    expect((await row(s.d.id)).status).toBe("resolved");
  });

  it("computes median time to resolution against the 7 day target", async () => {
    // Everything for this test lives in its own historical window so other cases in the database cannot leak in.
    const base = Date.now() - 400 * 86_400_000;
    const at = (days: number) => new Date(base + days * 86_400_000);
    const mk = async (openDay: number, resolveAfterDays: number, decidedBy: "auto" | "staff", followed: boolean, withBrief = true) => {
      const o = await fx.order();
      const d = await openDispute(o.buyer, { orderId: o.orderId, type: "damaged", description: "boxes were damaged" });
      fx.track(d.id);
      await prisma.dispute.update({ where: { id: d.id }, data: { status: "resolved", createdAt: at(openDay), dueAt: at(openDay + 7), resolvedAt: at(openDay + resolveAfterDays), activeOrderId: null } });
      await prisma.disputeDecision.create({ data: { disputeId: d.id, outcome: "split", refundPaise: 1n, releasePaise: 1n, decidedBy, followedRecommendation: followed, rationale: "test" } });
      if (withBrief) await prisma.disputeBrief.create({ data: { disputeId: d.id, version: 1, classifiedType: "damaged", summary: "s", citedEvidenceIds: [], specChecks: [], specVerdict: "inconclusive", recommendedOutcome: "split", recommendedRefundPaise: 1n, recommendedReleasePaise: 1n, rationale: "r", confidence: 0.7, evidenceCount: 1, provider: "heuristic", modelId: "m", promptVersion: "p" } });
      return { id: d.id, o };
    };
    const first = await mk(0, 2, "auto", true);
    await mk(1, 4, "staff", true);
    await mk(2, 9, "staff", false);
    await mk(3, 6, "staff", true, false);
    await prisma.disputeAppeal.create({ data: { disputeId: first.id, byBusinessId: first.o.buyer.businessId, byPersonId: first.o.buyer.personId, reason: "Appeal for the metrics test" } });
    const wd = await fx.order();
    const w = await openDispute(wd.buyer, { orderId: wd.orderId, type: "damaged", description: "boxes were damaged" });
    fx.track(w.id);
    await withdrawDispute(wd.buyer, w.id);
    await prisma.dispute.update({ where: { id: w.id }, data: { createdAt: at(4) } });
    const late = await fx.order();
    const ld = await openDispute(late.buyer, { orderId: late.orderId, type: "damaged", description: "boxes were damaged" });
    fx.track(ld.id);
    await prisma.dispute.update({ where: { id: ld.id }, data: { createdAt: at(5), dueAt: at(12) } }); // long overdue and still active

    const window = { from: at(-1), to: at(20) };
    const m = await disputeMetrics(window);
    expect(m).toMatchObject({ opened: 6, resolved: 4, withdrawn: 1, targetDays: 7, overdueActive: 1 });
    expect(m.medianResolutionDays).toBeCloseTo(5, 5); // durations 2d, 4d, 6d, 9d -> (4 + 6) / 2
    expect(m.meetsTarget).toBe(true);
    expect(m.withinSlaShare).toBeCloseTo(0.75, 5); // the 9-day case missed its 7-day deadline
    expect(m.autoResolvedShare).toBeCloseTo(0.25, 5);
    expect(m.appealRate).toBeCloseTo(0.25, 5);
    expect(m.briefAgreementRate).toBeCloseTo(2 / 3, 5);
    const empty = await disputeMetrics({ from: new Date(Date.now() + 86_400_000) });
    expect(empty).toMatchObject({ opened: 0, medianResolutionMs: null, meetsTarget: null, withinSlaShare: null, appealRate: null });
    expect((await disputeMetrics({ from: at(-1), to: at(0.5) })).opened).toBe(1);
  });
});

describe("retention (DPDP)", () => {
  it("purges personal content of old closed disputes but keeps the decision, amounts and structure", async () => {
    const { o, d } = await strongCase({ quantity: 200 });
    await runBrief(d.id);
    await postDisputeMessage(o.buyer, d.id, "Personal contact 9876543210");
    await adjudicateDispute(staffId, d.id, { outcome: "buyer_favour", rationale: "Clear evidence for the buyer" });
    expect(store.files.size).toBeGreaterThan(0);
    await purgeResolvedDisputeEvidence(new Date(Date.now() - 86_400_000)); // resolved just now: too recent
    expect((await row(d.id)).evidencePurgedAt).toBeNull();
    expect(await purgeResolvedDisputeEvidence(new Date(Date.now() + 86_400_000))).toBeGreaterThanOrEqual(1);
    expect(await purgeResolvedDisputeEvidence(new Date(Date.now() + 86_400_000))).toBe(0); // idempotent
    const ev = await prisma.disputeEvidence.findMany({ where: { disputeId: d.id } });
    expect(ev.every((e) => e.text === null && e.mediaKey === null && e.purgedAt !== null)).toBe(true);
    expect([...store.files.keys()].some((k) => k.includes(d.id))).toBe(false);
    const cur = await row(d.id);
    expect(cur.description).toContain("removed");
    expect(cur.evidencePurgedAt).not.toBeNull();
    expect((await prisma.disputeMessage.findFirstOrThrow({ where: { disputeId: d.id } })).body).toContain("removed");
    expect((await prisma.disputeBrief.findFirstOrThrow({ where: { disputeId: d.id } })).summary).toContain("removed");
    expect(await prisma.disputeDecision.findUniqueOrThrow({ where: { disputeId: d.id } })).toMatchObject({ outcome: "buyer_favour" });
    const v = (await getDispute(o.buyer, d.id))!;
    expect(v.evidence.every((e) => e.purged)).toBe(true);
    expect(await readEvidenceFileForStaff(d.id, ev.find((e) => e.kind === "photo")!.id)).toBeNull();
  });

  it("leaves active disputes alone", async () => {
    const o = await fx.order();
    const d = await openDispute(o.buyer, { orderId: o.orderId, type: "damaged", description: "boxes were damaged" });
    fx.track(d.id);
    await purgeResolvedDisputeEvidence(new Date(Date.now() + 86_400_000));
    expect((await row(d.id)).evidencePurgedAt).toBeNull();
  });
});

describe("scheduled advance entry point", () => {
  it("is a no-op while the flag is off and runs the tick (logging only when something happened) when on", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { runAdvanceJob } = await import("../src/sla");
    process.env.DISPUTES_ENABLED = "false";
    await runAdvanceJob();
    expect(log).not.toHaveBeenCalled();
    process.env.DISPUTES_ENABLED = "true";
    const o = await fx.order();
    const d = await openDispute(o.buyer, { orderId: o.orderId, type: "damaged", description: "boxes were damaged" });
    fx.track(d.id);
    await prisma.dispute.update({ where: { id: d.id }, data: { dueAt: new Date(Date.now() - 1000), responseDueAt: new Date(Date.now() - 1000) } });
    await runAdvanceJob();
    expect(log).toHaveBeenCalledWith("[disputes] advance", expect.objectContaining({ briefed: expect.any(Number) }));
    log.mockRestore();
  });
});
