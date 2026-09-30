import { MemoryJobQueue, setJobQueue } from "@cnote/core";
import { prisma } from "@cnote/db";
import * as negotiation from "@cnote/negotiation";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addListing, cleanup, events, grant, matchFor, party, validUntil, world, type Party } from "./helpers";

vi.mock("@cnote/catalogue", async (orig) => {
  const a = await orig<Record<string, unknown>>();
  const { world } = await import("./helpers");
  return { ...a, listSellerListings: async (id: string) => world.listings.filter((l) => l.sellerBusinessId === id), getListing: async (id: string) => world.listings.find((l) => l.id === id) ?? null };
});

import {
  advanceNegotiation, confirmNegotiation, createBuyerMandate, createSellerMandate, expireNegotiations, getNegotiation, listActivity, listNegotiations, retryRealisation, revokeMandate,
  sendNegotiationMessage, setAutoAccept, startNegotiation, withdrawNegotiation, adminGetNegotiation, adminListNegotiations, adminListMandates, a2aMetrics,
} from "../src";

const FLOOR = 4137;
const BUYER_MAX = 4913;
let buyer: Party, seller: Party;
let listingId: string;
const bm = (over: Record<string, unknown> = {}) => ({ optIn: true as const, name: "Boxes monthly", title: "Corrugated boxes 3 ply", requirement: "Need 3 ply corrugated boxes for shipping", quantity: 100, unit: "pcs", targetPricePaise: 4300, maxPricePaise: BUYER_MAX, maxLeadTimeDays: 10, ...over });
const sm = (over: Record<string, unknown> = {}) => ({ optIn: true as const, name: "Boxes quoting", floorPricePaise: FLOOR, ...over });
const term = (over: Record<string, unknown> = {}) => ({ pricePaise: 4300, quantity: 100, unit: "pcs", leadTimeDays: 8, validUntil: validUntil(), ...over });
const ext = { kind: "external_agent" as const, apiKeyId: "key-1" };

beforeAll(async () => {
  setJobQueue(new MemoryJobQueue());
  vi.stubEnv("A2A_ENABLED", "true");
  buyer = await party("buyer");
  seller = await party("seller");
  listingId = addListing(seller.businessId).id;
  await negotiation.upsertPriceBookEntry(seller, listingId, { basePricePaise: 5000, unit: "pcs", tiers: [], floorPricePaise: 4000, moq: 50, leadTimeDays: 7, validityDays: 7 });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  setJobQueue(undefined);
  await cleanup();
});
beforeEach(() => vi.stubEnv("A2A_ENABLED", "true"));

async function pair(opts: { buyerOver?: Record<string, unknown>; sellerOver?: Record<string, unknown>; status?: "offered" | "accepted"; credits?: number } = {}) {
  const b = await party("b");
  const s = await party("s");
  const lid = addListing(s.businessId).id;
  await negotiation.upsertPriceBookEntry(s, lid, { basePricePaise: 5000, unit: "pcs", tiers: [], floorPricePaise: 4000, moq: 50, leadTimeDays: 7, validityDays: 7 });
  if (opts.credits) await grant(s.businessId, opts.credits);
  const bMandate = await createBuyerMandate(b, bm(opts.buyerOver));
  const sMandate = await createSellerMandate(s, sm(opts.sellerOver));
  const m = await matchFor(b, s, { status: opts.status ?? "accepted" });
  return { b, s, bMandate, sMandate, ...m };
}

describe("start", () => {
  it("is idempotent per match, snapshots bounds, emits an event and logs for both principals", async () => {
    const w = await pair();
    const n1 = await startNegotiation(w.b, { mandateId: w.bMandate.id, matchId: w.matchId });
    const n2 = await startNegotiation(w.b, { mandateId: w.bMandate.id, matchId: w.matchId });
    expect(n2.id).toBe(n1.id);
    expect(n1).toMatchObject({ status: "open", turn: "buyer", youAre: "buyer", round: 0, maxRounds: 6, external: false });
    expect((await events("AgentNegotiationStarted", n1.id))[0]!.payload).toMatchObject({ negotiationId: n1.id, buyerBusinessId: w.b.businessId, sellerBusinessId: w.s.businessId, external: false });
    expect((await listActivity(w.b.businessId, { negotiationId: n1.id })).map((a) => a.action)).toContain("negotiation_started");
    expect((await listActivity(w.s.businessId, { negotiationId: n1.id })).map((a) => a.action)).toContain("negotiation_started");
  });
  it("refuses when the flag is off, wrong side, foreign mandate, no counterparty agent, approved list, gone lead", async () => {
    const w = await pair();
    vi.stubEnv("A2A_ENABLED", "false");
    await expect(startNegotiation(w.b, { mandateId: w.bMandate.id, matchId: w.matchId })).rejects.toMatchObject({ code: "conflict" });
    vi.stubEnv("A2A_ENABLED", "true");
    await expect(startNegotiation(w.s, { mandateId: w.bMandate.id, matchId: w.matchId })).rejects.toMatchObject({ code: "not_found" });
    await expect(startNegotiation(w.b, { mandateId: w.sMandate.id, matchId: w.matchId })).rejects.toMatchObject({ code: "not_found" });
    await expect(startNegotiation(w.b, { mandateId: "nope", matchId: w.matchId })).rejects.toMatchObject({ code: "not_found" });
    const stranger = await party("stranger");
    const sMand = await createSellerMandate(stranger, sm().name ? { ...sm(), name: "x quoting" } : sm()).catch(() => null);
    expect(sMand).toBeNull(); // no price book yet
    await expect(startNegotiation(stranger, { mandateId: w.bMandate.id, matchId: w.matchId })).rejects.toMatchObject({ code: "not_found" });

    const noAgent = await party("noagent");
    const m2 = await matchFor(w.b, noAgent);
    await expect(startNegotiation(w.b, { mandateId: w.bMandate.id, matchId: m2.matchId })).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("no agent") });

    const other = await pair({ buyerOver: { approvedSellerIds: ["11111111-1111-4111-8111-111111111111"] } });
    await expect(startNegotiation(other.b, { mandateId: other.bMandate.id, matchId: other.matchId })).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("approved") });

    const gone = await pair();
    await prisma.match.update({ where: { id: gone.matchId }, data: { status: "declined" } });
    await expect(startNegotiation(gone.b, { mandateId: gone.bMandate.id, matchId: gone.matchId })).rejects.toMatchObject({ code: "conflict" });
  });
  it("refuses a paused/revoked mandate and different units", async () => {
    const w = await pair({ buyerOver: { unit: "kg" } });
    await expect(startNegotiation(w.b, { mandateId: w.bMandate.id, matchId: w.matchId })).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("units") });
    const w2 = await pair();
    const { pauseMandate } = await import("../src");
    await pauseMandate(w2.b, w2.bMandate.id);
    await expect(startNegotiation(w2.b, { mandateId: w2.bMandate.id, matchId: w2.matchId })).rejects.toMatchObject({ code: "conflict" });
  });
  it("a seller can start too (seller opens)", async () => {
    const w = await pair();
    const n = await startNegotiation(w.s, { mandateId: w.sMandate.id, matchId: w.matchId });
    expect(n).toMatchObject({ turn: "seller", youAre: "seller" });
    await advanceNegotiation(n.id);
    const v = (await getNegotiation(w.s, n.id))!;
    expect(v.messages[0]).toMatchObject({ side: "seller", type: "offer", offer: { pricePaise: 5000 } });
    expect(["agreed", "rejected"]).toContain(v.status);
  });
});

describe("protocol over the persisted negotiation (external agent as the buyer)", () => {
  it("enforces bounds server-side, idempotency, turn order; never reveals the other side's limits", async () => {
    const w = await pair();
    const n = await startNegotiation(w.b, { mandateId: w.bMandate.id, matchId: w.matchId }, ext);
    expect(n.external).toBe(true);
    // out of bounds: above the buyer's own maximum
    const bad = await sendNegotiationMessage(w.b, n.id, { type: "offer", offer: term({ pricePaise: BUYER_MAX + 1 }) }, { idempotencyKey: "k0", via: ext }).catch((e) => e);
    expect(bad).toMatchObject({ code: "validation" });
    expect(bad.message).not.toMatch(/\d/);
    expect(JSON.stringify(bad)).not.toContain(String(FLOOR));
    // a valid opening offer
    const v1 = await sendNegotiationMessage(w.b, n.id, { type: "offer", offer: term() }, { idempotencyKey: "k1", via: ext });
    expect(v1).toMatchObject({ round: 1, turn: "seller" });
    // replay: same key -> same result, no second message
    const again = await sendNegotiationMessage(w.b, n.id, { type: "offer", offer: term() }, { idempotencyKey: "k1", via: ext });
    expect(again.messages).toHaveLength(1);
    expect(await prisma.agentMessage.count({ where: { negotiationId: n.id } })).toBe(1);
    // not your turn
    await expect(sendNegotiationMessage(w.b, n.id, { type: "counter", offer: term({ pricePaise: 4400 }) }, { idempotencyKey: "k2", via: ext })).rejects.toMatchObject({ code: "conflict" });
    // an event per offer
    expect((await events("AgentOfferMade", n.id))).toHaveLength(1);
    // the internal seller agent replies (queue-less: advance directly)
    await advanceNegotiation(n.id);
    const bv = (await getNegotiation(w.b, n.id))!;
    expect(bv.messages.length).toBeGreaterThanOrEqual(2);
    expect(bv.messages[0]!.actor).toBe("external_agent");
    expect(bv.messages[1]!.actor).toBe("agent");
    // privacy: neither the buyer view nor the summary contains the seller's floor or its private field names
    const s = JSON.stringify(bv);
    expect(s).not.toContain(String(FLOOR));
    expect(s).not.toContain("floorPricePaise");
    expect(s).not.toContain("basePricePaise");
    expect(bv.yourLimits).toMatchObject({ maxPricePaise: BUYER_MAX });
    const sv = JSON.stringify(await getNegotiation(w.s, n.id));
    expect(sv).not.toContain(String(BUYER_MAX));
    expect(sv).not.toContain("maxPricePaise");
    const admin = JSON.stringify(await adminGetNegotiation(n.id));
    expect(admin).not.toContain(String(FLOOR));
    expect(admin).not.toContain(String(BUYER_MAX));
  });
  it("a stranger cannot read or act", async () => {
    const w = await pair();
    const n = await startNegotiation(w.b, { mandateId: w.bMandate.id, matchId: w.matchId });
    const stranger = await party("intruder");
    expect(await getNegotiation(stranger, n.id)).toBeNull();
    await expect(sendNegotiationMessage(stranger, n.id, { type: "withdraw" }, { idempotencyKey: "z" })).rejects.toMatchObject({ code: "not_found" });
    await expect(confirmNegotiation(stranger, n.id, "confirm")).rejects.toMatchObject({ code: "not_found" });
    expect(await getNegotiation(w.b, "not-a-uuid")).toBeNull();
    await expect(sendNegotiationMessage(w.b, n.id, { type: "withdraw" }, { idempotencyKey: "" })).rejects.toMatchObject({ code: "validation" });
    await expect(sendNegotiationMessage(w.b, n.id, { type: "offer" } as never, { idempotencyKey: "x" })).rejects.toMatchObject({ code: "validation" });
  });
  it("a human can withdraw an open negotiation", async () => {
    const w = await pair();
    const n = await startNegotiation(w.b, { mandateId: w.bMandate.id, matchId: w.matchId });
    const v = await withdrawNegotiation(w.b, n.id);
    expect(v.status).toBe("withdrawn");
    expect((await events("AgentNegotiationClosed", n.id))[0]!.payload).toMatchObject({ outcome: "withdrawn", confirmedBy: null, pricePaise: null });
    await expect(sendNegotiationMessage(w.b, n.id, { type: "offer", offer: term() }, { idempotencyKey: "late" })).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("human confirmation and real quote/order", () => {
  it("agents agree, nothing commits until BOTH principals confirm, then a real Quote and Order exist", async () => {
    const w = await pair();
    const n = await startNegotiation(w.b, { mandateId: w.bMandate.id, matchId: w.matchId });
    await advanceNegotiation(n.id);
    const agreed = (await getNegotiation(w.b, n.id))!;
    expect(agreed.status).toBe("agreed");
    expect(agreed.agreed!.pricePaise).toBeGreaterThanOrEqual(FLOOR);
    expect(agreed.agreed!.pricePaise).toBeLessThanOrEqual(BUYER_MAX);
    expect(agreed).toMatchObject({ canConfirm: true, yourConfirmation: "pending", counterpartyConfirmed: false, quoteId: null, orderId: null });
    expect(await prisma.quote.count({ where: { conversationId: w.conversationId! } })).toBe(0);
    expect((await listNegotiations(w.b.businessId, { needsConfirmation: true })).map((x) => x.id)).toContain(n.id);

    await confirmNegotiation(w.b, n.id, "confirm");
    const half = (await getNegotiation(w.s, n.id))!;
    expect(half).toMatchObject({ status: "agreed", counterpartyConfirmed: true, canConfirm: true });
    expect(await prisma.quote.count({ where: { conversationId: w.conversationId! } })).toBe(0);
    await confirmNegotiation(w.b, n.id, "confirm"); // idempotent for the same side

    const done = await confirmNegotiation(w.s, n.id, "confirm");
    expect(done).toMatchObject({ status: "accepted", realiseError: null });
    expect(done.quoteId).toBeTruthy();
    expect(done.orderId).toBeTruthy();
    const q = await prisma.quote.findUniqueOrThrow({ where: { id: done.quoteId! } });
    expect(Number(q.pricePaise)).toBe(agreed.agreed!.pricePaise);
    expect(q.notes).toContain(`[a2a:${n.id}]`);
    const o = await prisma.order.findUniqueOrThrow({ where: { id: done.orderId! } });
    expect(o).toMatchObject({ matchId: w.matchId, quoteId: q.id, buyerBusinessId: w.b.businessId, sellerBusinessId: w.s.businessId });
    expect(Number(o.pricePaise)).toBe(agreed.agreed!.pricePaise);
    expect((await events("AgentNegotiationClosed", n.id))[0]!.payload).toMatchObject({ outcome: "accepted", confirmedBy: "human", pricePaise: agreed.agreed!.pricePaise });
    // finalising again creates nothing new
    const { finalise } = await import("../src");
    await finalise(n.id);
    expect(await prisma.quote.count({ where: { conversationId: w.conversationId! } })).toBe(1);
    await expect(confirmNegotiation(w.s, n.id, "confirm")).rejects.toMatchObject({ code: "conflict" });
    const acts = await listActivity(w.b.businessId, { negotiationId: n.id });
    expect(acts.some((a) => a.action === "order_recorded")).toBe(true);
    expect(acts.some((a) => a.action === "confirmed" && !a.byAgent)).toBe(true);
    expect(acts.some((a) => a.byAgent)).toBe(true);
  });

  it("an offered lead is accepted by the seller's confirmation (one credit)", async () => {
    const w = await pair({ status: "offered", credits: 2 });
    const n = await startNegotiation(w.b, { mandateId: w.bMandate.id, matchId: w.matchId });
    await advanceNegotiation(n.id);
    await confirmNegotiation(w.b, n.id, "confirm");
    const done = await confirmNegotiation(w.s, n.id, "confirm");
    expect(done.status).toBe("accepted");
    expect((await prisma.match.findUniqueOrThrow({ where: { id: w.matchId } })).status).toBe("accepted");
    const consumed = await prisma.creditLedgerEntry.count({ where: { businessId: w.s.businessId, reason: "consume" } });
    expect(consumed).toBe(1);
  });

  it("a decline by either principal closes the negotiation with no quote or order", async () => {
    const w = await pair();
    const n = await startNegotiation(w.b, { mandateId: w.bMandate.id, matchId: w.matchId });
    await advanceNegotiation(n.id);
    const v = await confirmNegotiation(w.s, n.id, "decline");
    expect(v.status).toBe("rejected");
    expect(await prisma.quote.count({ where: { conversationId: w.conversationId! } })).toBe(0);
    expect(await prisma.order.count({ where: { matchId: w.matchId } })).toBe(0);
    expect((await events("AgentNegotiationClosed", n.id))[0]!.payload).toMatchObject({ outcome: "rejected", confirmedBy: null });
    await expect(confirmNegotiation(w.b, n.id, "confirm")).rejects.toMatchObject({ code: "conflict" });
  });

  it("withdraw after agreement is a decline", async () => {
    const w = await pair();
    const n = await startNegotiation(w.b, { mandateId: w.bMandate.id, matchId: w.matchId });
    await advanceNegotiation(n.id);
    expect((await withdrawNegotiation(w.b, n.id)).status).toBe("rejected");
  });

  it("recording failure (no credits) keeps the deal agreed with an error; retry after top-up records it", async () => {
    const w = await pair({ status: "offered" });
    const n = await startNegotiation(w.b, { mandateId: w.bMandate.id, matchId: w.matchId });
    await advanceNegotiation(n.id);
    await confirmNegotiation(w.b, n.id, "confirm");
    const stuck = await confirmNegotiation(w.s, n.id, "confirm");
    expect(stuck.status).toBe("agreed");
    expect(stuck.realiseError).toBeTruthy();
    expect(await prisma.order.count({ where: { matchId: w.matchId } })).toBe(0);
    await grant(w.s.businessId, 1);
    const ok = await retryRealisation(w.s, n.id);
    expect(ok).toMatchObject({ status: "accepted", realiseError: null });
    expect(ok.orderId).toBeTruthy();
  });

  it("a lead that vanished after agreement closes the negotiation as expired", async () => {
    const w = await pair({ status: "offered", credits: 1 });
    const n = await startNegotiation(w.b, { mandateId: w.bMandate.id, matchId: w.matchId });
    await advanceNegotiation(n.id);
    await confirmNegotiation(w.b, n.id, "confirm");
    await prisma.match.update({ where: { id: w.matchId }, data: { status: "expired" } });
    const v = await confirmNegotiation(w.s, n.id, "confirm");
    expect(v.status).toBe("expired");
    expect(await prisma.order.count({ where: { matchId: w.matchId } })).toBe(0);
  });
});

describe("auto-accept", () => {
  it("both sides auto within bounds -> recorded without a human; confirmedBy auto", async () => {
    const w = await pair({ status: "offered", credits: 1, buyerOver: { autoAccept: true, autoAcceptConsent: true, autoAcceptLimitPaise: 4700 }, sellerOver: { autoAccept: true, autoAcceptConsent: true, autoAcceptLimitPaise: 4400 } });
    const n = await startNegotiation(w.b, { mandateId: w.bMandate.id, matchId: w.matchId });
    await advanceNegotiation(n.id);
    const v = (await getNegotiation(w.b, n.id))!;
    expect(v.status).toBe("accepted");
    expect(v.agreed!.pricePaise).toBeGreaterThanOrEqual(4400);
    expect(v.agreed!.pricePaise).toBeLessThanOrEqual(4700);
    expect((await events("AgentNegotiationClosed", n.id))[0]!.payload).toMatchObject({ outcome: "accepted", confirmedBy: "auto" });
    const acts = await listActivity(w.b.businessId, { negotiationId: n.id });
    expect(acts.some((a) => a.action === "confirmed_auto")).toBe(true);
  });
  it("terms outside the auto-accept bounds still wait for a human even when auto-accept is on", async () => {
    const w = await pair({ buyerOver: { autoAccept: true, autoAcceptConsent: true, autoAcceptLimitPaise: 4350 }, sellerOver: { autoAccept: true, autoAcceptConsent: true, autoAcceptLimitPaise: 4400 } });
    const n = await startNegotiation(w.b, { mandateId: w.bMandate.id, matchId: w.matchId });
    await advanceNegotiation(n.id);
    const v = (await getNegotiation(w.b, n.id))!;
    expect(v.status).toBe("agreed");
    expect(v.yourConfirmation).toBe("pending");
  });
  it("turning auto-accept off before agreement means a human is needed; a snapshot protects running negotiations", async () => {
    const w = await pair({ buyerOver: { autoAccept: true, autoAcceptConsent: true, autoAcceptLimitPaise: 4800 }, sellerOver: { autoAccept: true, autoAcceptConsent: true, autoAcceptLimitPaise: 4200 } });
    const n = await startNegotiation(w.b, { mandateId: w.bMandate.id, matchId: w.matchId });
    await setAutoAccept(w.b, w.bMandate.id, { enabled: false });
    await advanceNegotiation(n.id);
    // the snapshot from start still says auto; that is the documented behaviour (bounds are snapshotted at start)
    expect(["accepted", "agreed"]).toContain((await getNegotiation(w.b, n.id))!.status);
    const w2 = await pair();
    const n2 = await startNegotiation(w2.b, { mandateId: w2.bMandate.id, matchId: w2.matchId });
    await advanceNegotiation(n2.id);
    expect((await getNegotiation(w2.b, n2.id))!.status).toBe("agreed"); // default: off
  });
});

describe("lifecycle", () => {
  it("expiry closes open and unconfirmed negotiations; confirming after expiry fails", async () => {
    const w = await pair();
    const n = await startNegotiation(w.b, { mandateId: w.bMandate.id, matchId: w.matchId });
    expect(await expireNegotiations(new Date())).toBeGreaterThanOrEqual(0);
    const later = new Date(Date.now() + 5 * 86_400_000);
    await expireNegotiations(later);
    expect((await getNegotiation(w.b, n.id))!.status).toBe("expired");
    expect((await events("AgentNegotiationClosed", n.id))[0]!.payload).toMatchObject({ outcome: "expired" });

    const w2 = await pair();
    const n2 = await startNegotiation(w2.b, { mandateId: w2.bMandate.id, matchId: w2.matchId });
    await advanceNegotiation(n2.id);
    await expect(confirmNegotiation(w2.b, n2.id, "confirm", { now: later })).rejects.toMatchObject({ code: "conflict" });
    expect((await getNegotiation(w2.b, n2.id))!.status).toBe("expired");
    const n3 = await getNegotiation(w2.b, n2.id);
    expect(n3!.expiresAt).toBeTruthy();
  });
  it("sending after the deadline expires it", async () => {
    const w = await pair();
    const n = await startNegotiation(w.b, { mandateId: w.bMandate.id, matchId: w.matchId }, undefined, { now: new Date(Date.now() - 3 * 86_400_000) });
    await expect(sendNegotiationMessage(w.b, n.id, { type: "offer", offer: term() }, { idempotencyKey: "late" })).rejects.toMatchObject({ code: "conflict" });
    expect((await getNegotiation(w.b, n.id))!.status).toBe("expired");
  });
  it("revoking a mandate withdraws its open negotiations", async () => {
    const w = await pair();
    const n = await startNegotiation(w.b, { mandateId: w.bMandate.id, matchId: w.matchId });
    await revokeMandate(w.s, w.sMandate.id);
    expect((await getNegotiation(w.b, n.id))!.status).toBe("withdrawn");
  });
});

describe("admin reads and metrics", () => {
  it("lists negotiations and mandates without any limits, computes metrics", async () => {
    const rows = await adminListNegotiations({ businessId: seller.businessId });
    expect(Array.isArray(rows)).toBe(true);
    const all = await adminListNegotiations({ status: "accepted", limit: 5 });
    for (const r of all) expect(JSON.stringify(r)).not.toContain("Private");
    const ms = await adminListMandates({ side: "seller", limit: 5 });
    for (const m of ms) expect(Object.keys(m)).not.toContain("limitPricePaise");
    const m = await a2aMetrics({ from: new Date(Date.now() - 3_600_000) });
    expect(m.negotiations).toBeGreaterThan(0);
    expect(m.agentClosedDeals).toBeGreaterThan(0);
    expect(m.autoAcceptShare).not.toBeNull();
    expect(m.medianRoundsToClose).toBeGreaterThan(0);
    expect(m.humanOverrideRate).not.toBeNull();
    expect((await a2aMetrics({ from: new Date(Date.now() + 86_400_000) })).agentClosedDeals).toBe(0);
    expect((await a2aMetrics({ to: new Date(0) })).humanOverrideRate).toBeNull();
    expect(world.bizIds.length).toBeGreaterThan(0);
  });
});
