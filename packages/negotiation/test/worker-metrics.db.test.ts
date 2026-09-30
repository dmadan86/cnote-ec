import { getJobQueue } from "@cnote/core";
import { prisma } from "@cnote/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { acceptedLead, addListing, cleanup, party, type Party } from "./helpers";

vi.mock("@cnote/catalogue", async (orig) => {
  const a = await orig<Record<string, unknown>>();
  const { world } = await import("./helpers");
  return { ...a, listSellerListings: async (id: string) => world.listings.filter((l) => l.sellerBusinessId === id), getListing: async (id: string) => world.listings.find((l) => l.id === id) ?? null };
});

import { approveDraft, draftMetrics, generateDraft, isQuoteAssistEnabled, listAgentActions, listPriceBook, timeToFirstQuote, worker } from "../src";
import { DRAFT_TOPIC, handleDraftJob, onLeadAccepted, onQuoteSent } from "../src/worker";

let buyer: Party, seller: Party;
beforeAll(async () => { buyer = await party("b"); seller = await party("s"); addListing(seller.businessId); await listPriceBook(seller.businessId); });
afterAll(cleanup);
afterEach(() => vi.unstubAllEnvs());

describe("feature flag", () => {
  it("is off by default and understands true/1/yes", () => {
    expect(isQuoteAssistEnabled()).toBe(false);
    for (const v of ["true", "1", "yes", " TRUE "]) { vi.stubEnv("QUOTE_ASSIST_ENABLED", v); expect(isQuoteAssistEnabled()).toBe(true); }
    for (const v of ["false", "0", "", "off"]) { vi.stubEnv("QUOTE_ASSIST_ENABLED", v); expect(isQuoteAssistEnabled()).toBe(false); }
  });
});

describe("worker", () => {
  it("exports the module worker shape with both handlers and the draft queue", () => {
    expect(worker.name).toBe("negotiation");
    expect(Object.keys(worker.handlers).sort()).toEqual(["LeadAccepted", "QuoteSent"]);
    expect(worker.queues?.map((q) => q.topic)).toEqual([DRAFT_TOPIC]);
  });

  it("LeadAccepted records timing even with the flag off, and enqueues no draft job", async () => {
    const l = await acceptedLead(buyer, seller);
    const spy = vi.spyOn(getJobQueue(), "enqueue");
    await onLeadAccepted({ matchId: l.matchId, sellerBusinessId: seller.businessId }, "2026-10-01T10:00:00Z");
    expect(spy).not.toHaveBeenCalled();
    expect(await prisma.leadQuoteTiming.findUniqueOrThrow({ where: { matchId: l.matchId } })).toMatchObject({ conversationId: l.conversationId, firstQuoteAt: null, assisted: false });
    // idempotent redelivery keeps the original acceptedAt
    await onLeadAccepted({ matchId: l.matchId, sellerBusinessId: seller.businessId }, "2026-10-02T10:00:00Z");
    expect((await prisma.leadQuoteTiming.findUniqueOrThrow({ where: { matchId: l.matchId } })).acceptedAt.toISOString()).toBe("2026-10-01T10:00:00.000Z");
    spy.mockRestore();
  });

  it("LeadAccepted with the flag on enqueues one deduped draft job", async () => {
    vi.stubEnv("QUOTE_ASSIST_ENABLED", "true");
    const l = await acceptedLead(buyer, seller);
    const spy = vi.spyOn(getJobQueue(), "enqueue").mockResolvedValue("id");
    await onLeadAccepted({ matchId: l.matchId, sellerBusinessId: seller.businessId }, new Date().toISOString());
    expect(spy).toHaveBeenCalledWith(DRAFT_TOPIC, { matchId: l.matchId, sellerBusinessId: seller.businessId }, { dedupeKey: `draft:${l.matchId}` });
    spy.mockRestore();
  });

  it("LeadAccepted for a lead without a conversation records no timing", async () => {
    const l = await acceptedLead(buyer, seller, { status: "offered" });
    await onLeadAccepted({ matchId: l.matchId, sellerBusinessId: seller.businessId }, new Date().toISOString());
    expect(await prisma.leadQuoteTiming.count({ where: { matchId: l.matchId } })).toBe(0);
  });

  it("the draft job drafts when enabled, does nothing when disabled, swallows domain errors and rethrows unexpected ones", async () => {
    const l = await acceptedLead(buyer, seller);
    await handleDraftJob({ matchId: l.matchId, sellerBusinessId: seller.businessId });
    expect(await prisma.quoteDraft.count({ where: { matchId: l.matchId } })).toBe(0);
    vi.stubEnv("QUOTE_ASSIST_ENABLED", "true");
    await handleDraftJob({ matchId: l.matchId, sellerBusinessId: seller.businessId });
    expect(await prisma.quoteDraft.count({ where: { matchId: l.matchId } })).toBe(1);
    await expect(handleDraftJob({ matchId: "00000000-0000-4000-8000-000000000000", sellerBusinessId: seller.businessId })).resolves.toBeUndefined();
    const spy = vi.spyOn(prisma.quoteDraft, "findUnique").mockRejectedValueOnce(new Error("db down"));
    await expect(handleDraftJob({ matchId: l.matchId, sellerBusinessId: seller.businessId })).rejects.toThrow("db down");
    spy.mockRestore();
  });

  it("QuoteSent closes timing once (first quote only)", async () => {
    const l = await acceptedLead(buyer, seller);
    await prisma.leadQuoteTiming.create({ data: { matchId: l.matchId, conversationId: l.conversationId!, sellerBusinessId: seller.businessId, acceptedAt: new Date("2026-10-01T10:00:00Z") } });
    await onQuoteSent({ conversationId: l.conversationId! }, "2026-10-01T10:30:00Z");
    await onQuoteSent({ conversationId: l.conversationId! }, "2026-10-01T15:00:00Z");
    expect((await prisma.leadQuoteTiming.findUniqueOrThrow({ where: { matchId: l.matchId } })).firstQuoteAt!.toISOString()).toBe("2026-10-01T10:30:00.000Z");
  });
});

describe("metrics", () => {
  it("draft acceptance, edit distance and time-to-first-quote before/after, scoped by range", async () => {
    const s = await party("metrics-seller");
    addListing(s.businessId);
    const from = new Date(Date.now() - 1000);
    const mk = async () => { const l = await acceptedLead(buyer, s); await prisma.leadQuoteTiming.create({ data: { matchId: l.matchId, conversationId: l.conversationId!, sellerBusinessId: s.businessId, acceptedAt: new Date(Date.now() - 3_600_000) } }); return { l, d: (await generateDraft(s.businessId, l.matchId))! }; };
    const a = await mk(), b = await mk(), c = await mk(), d = await mk();
    await approveDraft(s, a.d.id);
    await approveDraft(s, b.d.id, { pricePaise: 5100, notes: "changed" });
    await prisma.quoteDraft.update({ where: { id: c.d.id }, data: { status: "discarded" } });
    const m = await draftMetrics({ from });
    const mine = await prisma.quoteDraft.count({ where: { sellerBusinessId: s.businessId } });
    expect(mine).toBe(4);
    expect(m.generated).toBeGreaterThanOrEqual(4);
    expect(m.approved).toBeGreaterThanOrEqual(2);
    expect(m.acceptanceRate).toBeGreaterThan(0);
    expect(m.uneditedRate).toBeGreaterThan(0);
    expect(m.uneditedRate).toBeLessThan(1);
    expect(m.avgEditedFields).toBeGreaterThan(0);
    expect(m.avgAbsPriceDeltaPct).toBeGreaterThan(0);
    expect(m.avgNotesEditDistance).toBeGreaterThan(0);
    expect(m.pending).toBeGreaterThanOrEqual(1);
    expect(typeof m.boundsRejections).toBe("number");
    const future = await draftMetrics({ from: new Date(Date.now() + 100_000) });
    expect(future).toMatchObject({ generated: 0, approved: 0, acceptanceRate: null, uneditedRate: null, avgEditedFields: null, avgAbsPriceDeltaPct: null, avgNotesEditDistance: null });
    expect((await draftMetrics({ to: new Date(Date.now() + 100_000) })).generated).toBeGreaterThanOrEqual(4);

    // time to first quote: a manual lead (30 min) vs assisted leads (a and b just approved) for this seller
    const manual = await acceptedLead(buyer, s);
    const t0 = new Date("2026-01-01T10:00:00Z");
    await prisma.leadQuoteTiming.create({ data: { matchId: manual.matchId, conversationId: manual.conversationId!, sellerBusinessId: s.businessId, acceptedAt: t0, firstQuoteAt: new Date(t0.getTime() + 30 * 60_000), assisted: false } });
    const noQuoteYet = await acceptedLead(buyer, s);
    await prisma.leadQuoteTiming.create({ data: { matchId: noQuoteYet.matchId, conversationId: noQuoteYet.conversationId!, sellerBusinessId: s.businessId, acceptedAt: t0 } });
    // simulate the QuoteSent events for the two approvals (the worker handler normally does this)
    await onQuoteSent({ conversationId: a.l.conversationId! }, new Date(Date.now() - 3_600_000 + 5 * 60_000).toISOString());
    await onQuoteSent({ conversationId: b.l.conversationId! }, new Date(Date.now() - 3_600_000 + 7 * 60_000).toISOString());
    const ttfq = await timeToFirstQuote({ sellerBusinessId: s.businessId });
    expect(ttfq.manual).toMatchObject({ n: 1, medianMs: 30 * 60_000, meanMs: 30 * 60_000 });
    expect(ttfq.assisted.n).toBe(2);
    expect(ttfq.assisted.medianMs).toBeGreaterThan(4 * 60_000);
    expect(ttfq.assisted.medianMs).toBeLessThan(8 * 60_000);
    expect(ttfq.assisted.p90Ms).toBeGreaterThanOrEqual(ttfq.assisted.medianMs!);
    expect(ttfq.medianSavedMs).toBeGreaterThan(20 * 60_000);
    const empty = await timeToFirstQuote({ sellerBusinessId: s.businessId, from: new Date("2030-01-01") });
    expect(empty).toEqual({ assisted: { n: 0, meanMs: null, medianMs: null, p90Ms: null }, manual: { n: 0, meanMs: null, medianMs: null, p90Ms: null }, medianSavedMs: null });
    expect((await timeToFirstQuote({ from: new Date("2025-12-31"), to: new Date("2026-01-02") })).manual.n).toBeGreaterThanOrEqual(1);
    void d;
  });

  it("odd-sized cohorts use the middle element", async () => {
    const s = await party("odd");
    for (const min of [10, 20, 90]) {
      const l = await acceptedLead(buyer, s);
      const t0 = new Date("2026-02-01T10:00:00Z");
      await prisma.leadQuoteTiming.create({ data: { matchId: l.matchId, conversationId: l.conversationId!, sellerBusinessId: s.businessId, acceptedAt: t0, firstQuoteAt: new Date(t0.getTime() + min * 60_000) } });
    }
    expect((await timeToFirstQuote({ sellerBusinessId: s.businessId })).manual).toMatchObject({ n: 3, medianMs: 20 * 60_000 });
    expect(await listAgentActions(s.businessId, { role: "buyer" })).toEqual([]);
    expect(await listAgentActions(s.businessId, { enquiryId: "bad", subjectId: "bad", limit: 0 })).toEqual([]);
  });
});
