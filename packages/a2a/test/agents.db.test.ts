import { DomainError, MemoryJobQueue, setJobQueue } from "@cnote/core";
import { prisma } from "@cnote/db";
import * as negotiation from "@cnote/negotiation";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addListing, cleanup, matchFor, party, validUntil, world, type Party } from "./helpers";

vi.mock("@cnote/catalogue", async (orig) => {
  const a = await orig<Record<string, unknown>>();
  const { world } = await import("./helpers");
  return { ...a, listSellerListings: async (id: string) => world.listings.filter((l) => l.sellerBusinessId === id), getListing: async (id: string) => world.listings.find((l) => l.id === id) ?? null };
});
const hooks = { sellers: [] as Party[], fail: null as Error | null, calls: 0 };
vi.mock("@cnote/enquiry", async (orig) => {
  const a = await orig<typeof import("@cnote/enquiry")>();
  return {
    ...a,
    createEnquiry: async (actor: { personId: string; businessId: string }) => {
      hooks.calls++;
      if (hooks.fail) throw hooks.fail;
      const { prisma } = await import("@cnote/db");
      const e = await prisma.enquiry.create({ data: { buyerBusinessId: actor.businessId, buyerPersonId: actor.personId, title: "Corrugated boxes 3 ply", requirement: "Need 3 ply corrugated boxes", quantity: 100, quantityUnit: "pcs", status: "matched" } });
      const h = await import("./helpers");
      h.world.enquiryIds.push(e.id);
      let rank = 1;
      for (const s of hooks.sellers) await prisma.match.create({ data: { enquiryId: e.id, sellerBusinessId: s.businessId, rank: rank++, matchScore: 0.9, status: "offered", respondBy: new Date(Date.now() + 7_200_000) } });
      return { id: e.id };
    },
  };
});

import * as a2a from "../src";
import { ADVANCE_TOPIC, scheduleAdvance, scheduleFinalise } from "../src/queue";

let buyer: Party, agentSeller: Party, plainSeller: Party;
const bm = (over: Record<string, unknown> = {}) => ({ optIn: true as const, name: "Weekly boxes", title: "Corrugated boxes 3 ply", requirement: "Need 3 ply corrugated boxes for shipping", quantity: 100, unit: "pcs", targetPricePaise: 4300, maxPricePaise: 4913, maxLeadTimeDays: 10, ...over });

async function sellerWithAgent(name: string) {
  const s = await party(name);
  const l = addListing(s.businessId);
  await negotiation.upsertPriceBookEntry(s, l.id, { basePricePaise: 5000, unit: "pcs", tiers: [], floorPricePaise: 4000, moq: 50, leadTimeDays: 7, validityDays: 7 });
  await a2a.createSellerMandate(s, { optIn: true, name: `${name} quoting`, floorPricePaise: 4137 });
  return s;
}

beforeAll(async () => {
  setJobQueue(new MemoryJobQueue());
  vi.stubEnv("A2A_ENABLED", "true");
  buyer = await party("buyer");
  agentSeller = await sellerWithAgent("agent-seller");
  plainSeller = await party("plain-seller");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  setJobQueue(undefined);
  await cleanup();
});
beforeEach(() => {
  vi.stubEnv("A2A_ENABLED", "true");
  hooks.sellers = [agentSeller, plainSeller];
  hooks.fail = null;
});

describe("recurring buyer mandates", () => {
  it("post an enquiry as the buyer, negotiate with agent sellers, leave the rest to the human flow; idempotent per run", async () => {
    const m = await a2a.createBuyerMandate(buyer, bm({ recurrenceDays: 7, startAt: "2001-01-01T00:00:00Z" }));
    const res = await a2a.runMandate(m.id);
    expect(res).toMatchObject({ negotiations: 1, fallbackSellers: 1 });
    expect(res.enquiryId).toBeTruthy();
    const neg = await prisma.agentNegotiation.findFirstOrThrow({ where: { enquiryId: res.enquiryId! } });
    expect(neg).toMatchObject({ buyerBusinessId: buyer.businessId, sellerBusinessId: agentSeller.businessId, status: "open" });
    const after = (await a2a.getMandate(buyer.businessId, m.id))!;
    expect(after.status).toBe("active");
    expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    expect(after.lastRunAt).not.toBeNull();
    const run = await prisma.agentRun.findFirstOrThrow({ where: { mandateId: m.id } });
    expect(run).toMatchObject({ outcome: "posted", enquiryId: res.enquiryId });
    // not due again yet / retried tick
    expect(await a2a.runMandate(m.id)).toMatchObject({ skipped: "not due" });
    await prisma.agentMandate.update({ where: { id: m.id }, data: { nextRunAt: new Date(run.runKey) } });
    expect(await a2a.runMandate(m.id)).toMatchObject({ skipped: "already ran" });
    const acts = await a2a.listActivity(buyer.businessId, { mandateId: m.id });
    expect(acts.some((a) => a.action === "run_started" && a.summary.includes("1 agent negotiation"))).toBe(true);
    // the changes log records runs
    expect((await a2a.listMandateChanges(buyer.businessId, m.id)).some((c) => c.action === "run" && c.actorKind === "system")).toBe(true);
    // negotiate to the end
    await a2a.advanceNegotiation(neg.id);
    expect((await a2a.getNegotiation(buyer, neg.id))!.status).toBe("agreed");
  });

  it("a once-only mandate completes; a failing run still advances the schedule and logs why", async () => {
    const once = await a2a.createBuyerMandate(buyer, bm({ name: "Once" }));
    await a2a.runMandate(once.id);
    expect((await a2a.getMandate(buyer.businessId, once.id))!).toMatchObject({ status: "completed", nextRunAt: null });
    hooks.fail = new DomainError("rate_limited", "busy");
    const bad = await a2a.createBuyerMandate(buyer, bm({ name: "Fails", recurrenceDays: 1 }));
    const r = await a2a.runMandate(bad.id);
    expect(r.enquiryId).toBeNull();
    expect((await prisma.agentRun.findFirstOrThrow({ where: { mandateId: bad.id } })).outcome).toBe("failed");
    expect((await a2a.listActivity(buyer.businessId, { mandateId: bad.id })).some((a) => a.action === "run_failed")).toBe(true);
    expect(new Date((await a2a.getMandate(buyer.businessId, bad.id))!.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("runDueMandates respects the flag, expiry, pause and suspension; unknown/seller mandates are rejected", async () => {
    const OLD = new Date("2001-01-02T00:00:00Z"); // far in the past so parallel test files' mandates (due "now") are never picked up
    const due = await a2a.createBuyerMandate(buyer, bm({ name: "Due one", startAt: "2001-01-01T00:00:00Z" }));
    vi.stubEnv("A2A_ENABLED", "false");
    expect(await a2a.runDueMandates()).toEqual([]);
    expect(await a2a.sweepStalled()).toBe(0);
    expect(await a2a.advanceNegotiation("whatever")).toBe(0);
    vi.stubEnv("A2A_ENABLED", "true");
    const calls = hooks.calls;
    const paused = await a2a.createBuyerMandate(buyer, bm({ name: "Paused one", startAt: "2001-01-01T00:00:00Z" }));
    await a2a.pauseMandate(buyer, paused.id);
    const out = await a2a.runDueMandates(OLD);
    expect(out.some((r) => r.mandateId === due.id)).toBe(true);
    expect(out.some((r) => r.mandateId === paused.id)).toBe(false);
    expect(hooks.calls).toBeGreaterThan(calls);
    expect(await a2a.runMandate(paused.id)).toMatchObject({ skipped: "not due" });
    const exp = await a2a.createBuyerMandate(buyer, bm({ name: "Expiring", expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    await prisma.agentMandate.update({ where: { id: exp.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await a2a.runMandate(exp.id)).toMatchObject({ skipped: "expired" });
    const susp = await a2a.createBuyerMandate(buyer, bm({ name: "Suspended run" }));
    await prisma.agentSuspension.create({ data: { kind: "business", targetId: buyer.businessId, businessId: buyer.businessId, reason: "test suspension", suspendedBy: "t" } });
    expect((await a2a.runMandate(susp.id)).enquiryId).toBeNull();
    await prisma.agentSuspension.deleteMany({ where: { targetId: buyer.businessId } });
    await expect(a2a.runMandate("11111111-1111-4111-8111-111111111111")).rejects.toMatchObject({ code: "not_found" });
    await expect(a2a.runMandate(agentSeller.businessId)).rejects.toThrow();
  });

  it("an approved-list buyer skips other sellers to the human flow", async () => {
    hooks.sellers = [agentSeller];
    const m = await a2a.createBuyerMandate(buyer, bm({ name: "Approved only", approvedSellerIds: ["11111111-1111-4111-8111-111111111111"] }));
    expect(await a2a.runMandate(m.id)).toMatchObject({ negotiations: 0, fallbackSellers: 1 });
  });

  it("logs start_skipped when a seller agent cannot price the requirement (units differ)", async () => {
    hooks.sellers = [agentSeller];
    const m = await a2a.createBuyerMandate(buyer, bm({ name: "Kilos", unit: "kg" }));
    expect(await a2a.runMandate(m.id)).toMatchObject({ negotiations: 0, fallbackSellers: 1 });
    expect((await a2a.listActivity(buyer.businessId, { mandateId: m.id })).some((a) => a.action === "start_skipped")).toBe(true);
  });
});

describe("internal driver", () => {
  async function started() {
    const s = await sellerWithAgent("drv");
    const b = await party("drvb");
    const bmd = await a2a.createBuyerMandate(b, bm());
    const m = await matchFor(b, s, { status: "accepted" });
    const n = await a2a.startNegotiation(b, { mandateId: bmd.id, matchId: m.matchId });
    return { b, s, bmd, n };
  }
  it("waits when the mandate is paused, resumes after, and nextAgentAction is null for an external driver", async () => {
    const { b, bmd, n } = await started();
    await a2a.pauseMandate(b, bmd.id); // withdraws the negotiation too: use a fresh one for the paused case
    expect((await a2a.getNegotiation(b, n.id))!.status).toBe("withdrawn");
    expect(await a2a.nextAgentAction(n.id)).toBeNull();
    const f = await started();
    await prisma.agentNegotiation.update({ where: { id: f.n.id }, data: { buyerDriver: "external" } });
    expect(await a2a.nextAgentAction(f.n.id)).toBeNull();
    expect(await a2a.advanceNegotiation(f.n.id)).toBe(0);
    await prisma.agentNegotiation.update({ where: { id: f.n.id }, data: { buyerDriver: "internal" } });
    await prisma.agentMandate.update({ where: { id: f.bmd.id }, data: { status: "paused" } });
    expect(await a2a.advanceNegotiation(f.n.id)).toBe(0);
    await prisma.agentMandate.update({ where: { id: f.bmd.id }, data: { status: "active" } });
    expect(await a2a.advanceNegotiation(f.n.id)).toBeGreaterThan(0);
  });
  it("sweepStalled advances idle negotiations on an internal turn", async () => {
    const { n } = await started();
    await prisma.$executeRaw`UPDATE agent_negotiation SET updated_at = now() - interval '5 minutes' WHERE id = ${n.id}::uuid`;
    expect(await a2a.sweepStalled()).toBeGreaterThanOrEqual(1);
    expect((await prisma.agentNegotiation.findUniqueOrThrow({ where: { id: n.id } })).round).toBeGreaterThan(0);
  });
  it("the agent steps back (withdraws) when its own mandate can no longer make a legal move", async () => {
    const { n, bmd } = await started();
    // squeeze the snapshot so the buyer's opening offer is illegal (max below its target)
    await prisma.$executeRaw`UPDATE agent_negotiation SET buyer_private = jsonb_set(jsonb_set(buyer_private, '{maxPricePaise}', '0'), '{targetPricePaise}', 'null') WHERE id = ${n.id}::uuid`;
    await a2a.advanceNegotiation(n.id);
    const row = await prisma.agentNegotiation.findUniqueOrThrow({ where: { id: n.id } });
    expect(row.status).toBe("withdrawn");
    void bmd;
  });
  it("scheduling helpers enqueue without throwing and swallow queue failures", async () => {
    await scheduleAdvance("n1", 1);
    await scheduleFinalise("n1");
    setJobQueue({ enqueue: async () => { throw new Error("down"); } } as never);
    await scheduleAdvance("n1", 2);
    await scheduleFinalise("n1");
    setJobQueue(new MemoryJobQueue());
    expect(ADVANCE_TOPIC).toBe("a2a.advance");
  });
  it("the worker wires jobs and consumers", async () => {
    const { worker } = a2a;
    expect(worker.name).toBe("a2a");
    expect(worker.jobs.map((j) => j.name).sort()).toEqual(["a2a.expire", "a2a.run_mandates", "a2a.sweep"]);
    vi.stubEnv("A2A_ENABLED", "false"); // never sweep other test files' due mandates
    for (const j of worker.jobs) await j.run();
    vi.stubEnv("A2A_ENABLED", "true");
    expect(worker.queues!.map((q) => q.topic).sort()).toEqual(["a2a.advance", "a2a.finalise"]);
    const { n } = await started();
    const adv = worker.queues!.find((q) => q.topic === "a2a.advance")!;
    await adv.handler({ id: "x", topic: "a2a.advance", payload: { negotiationId: n.id }, attempt: 1, maxAttempts: 3, enqueuedAt: "" } as never);
    expect((await prisma.agentNegotiation.findUniqueOrThrow({ where: { id: n.id } })).round).toBeGreaterThan(0);
    const fin = worker.queues!.find((q) => q.topic === "a2a.finalise")!;
    await fin.handler({ id: "y", topic: "a2a.finalise", payload: { negotiationId: n.id }, attempt: 1, maxAttempts: 3, enqueuedAt: "" } as never);
    vi.stubEnv("A2A_ENABLED", "false");
    await fin.handler({ id: "y", topic: "a2a.finalise", payload: { negotiationId: n.id }, attempt: 1, maxAttempts: 3, enqueuedAt: "" } as never);
    expect(world.bizIds.length).toBeGreaterThan(0);
  });
});

describe("messages from an external seller agent into an internal buyer agent", () => {
  it("external seller opens, internal buyer agent responds, and they settle inside both bounds", async () => {
    const s = await sellerWithAgent("ext-seller");
    const b = await party("ext-buyer");
    const bmd = await a2a.createBuyerMandate(b, bm());
    const sMandate = (await a2a.listMandates(s.businessId))[0]!;
    const m = await matchFor(b, s, { status: "accepted" });
    const via = { kind: "external_agent" as const, apiKeyId: "ext-key" };
    const n = await a2a.startNegotiation(s, { mandateId: sMandate.id, matchId: m.matchId }, via);
    expect(n).toMatchObject({ turn: "seller", external: true });
    const v = await a2a.sendNegotiationMessage(s, n.id, { type: "offer", offer: { pricePaise: 5000, quantity: 100, unit: "pcs", leadTimeDays: 7, validUntil: validUntil() } }, { idempotencyKey: "o1", via });
    expect(v.turn).toBe("buyer");
    await a2a.advanceNegotiation(n.id);
    const cur = (await a2a.getNegotiation(s, n.id))!;
    expect(cur.messages.length).toBeGreaterThan(1);
    for (const x of cur.messages.filter((y) => y.offer && y.side === "buyer")) expect(x.offer!.pricePaise).toBeLessThanOrEqual(4913);
    void bmd;
  });
});
