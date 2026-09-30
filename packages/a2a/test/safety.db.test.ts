import { MemoryJobQueue, setJobQueue } from "@cnote/core";
import { prisma } from "@cnote/db";
import * as negotiation from "@cnote/negotiation";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addListing, cleanup, events, matchFor, party, validUntil, type Party } from "./helpers";

vi.mock("@cnote/catalogue", async (orig) => {
  const a = await orig<Record<string, unknown>>();
  const { world } = await import("./helpers");
  return { ...a, listSellerListings: async (id: string) => world.listings.filter((l) => l.sellerBusinessId === id), getListing: async (id: string) => world.listings.find((l) => l.id === id) ?? null };
});

import * as a2a from "../src";

const bm = () => ({ optIn: true as const, name: "Boxes", title: "Corrugated boxes 3 ply", requirement: "Need 3 ply corrugated boxes for shipping", quantity: 100, unit: "pcs", targetPricePaise: 4300, maxPricePaise: 4913 });
const term = (over: Record<string, unknown> = {}) => ({ pricePaise: 4300, quantity: 100, unit: "pcs", leadTimeDays: 8, validUntil: validUntil(), ...over });

async function world2() {
  const s = await party("s");
  const b = await party("b");
  const l = addListing(s.businessId);
  await negotiation.upsertPriceBookEntry(s, l.id, { basePricePaise: 5000, unit: "pcs", tiers: [], floorPricePaise: 4000, moq: 50, leadTimeDays: 7, validityDays: 7 });
  const sm = await a2a.createSellerMandate(s, { optIn: true, name: "Quote", floorPricePaise: 4137 });
  const bmd = await a2a.createBuyerMandate(b, bm());
  const m = await matchFor(b, s);
  return { s, b, sm, bmd, ...m };
}
let staff = "staff-1";
beforeAll(() => {
  setJobQueue(new MemoryJobQueue());
});
afterAll(async () => {
  vi.unstubAllEnvs();
  setJobQueue(undefined);
  await cleanup();
});
beforeEach(() => vi.stubEnv("A2A_ENABLED", "true"));

describe("suspension", () => {
  it("suspending a mandate withdraws its negotiations, blocks new ones, and lifting returns it paused", async () => {
    const w = await world2();
    const n = await a2a.startNegotiation(w.b, { mandateId: w.bmd.id, matchId: w.matchId });
    await expect(a2a.suspend({ kind: "mandate", targetId: w.bmd.id, reason: "no", by: staff })).rejects.toMatchObject({ code: "validation" });
    await expect(a2a.suspend({ kind: "mandate", targetId: "11111111-1111-4111-8111-111111111111", reason: "abuse pattern", by: staff })).rejects.toMatchObject({ code: "not_found" });
    const s1 = await a2a.suspend({ kind: "mandate", targetId: w.bmd.id, reason: "abusive pricing pattern", by: staff });
    const susp = await prisma.domainEvent.findMany({ where: { type: "AgentMandateSuspended", aggregateId: w.bmd.id } });
    expect(susp).toHaveLength(1);
    expect(susp[0]!.payload).toMatchObject({ mandateId: w.bmd.id, side: "buyer", scope: "mandate" });
    expect(JSON.stringify(susp[0]!.payload)).not.toContain("abusive"); // the reason stays in the admin trail
    expect(s1).toMatchObject({ kind: "mandate", businessId: w.b.businessId, liftedAt: null });
    expect((await a2a.suspend({ kind: "mandate", targetId: w.bmd.id, reason: "abusive pricing pattern", by: staff })).id).toBe(s1.id); // idempotent
    expect((await a2a.getMandate(w.b.businessId, w.bmd.id))!.status).toBe("suspended");
    expect((await a2a.getNegotiation(w.b, n.id))!.status).toBe("withdrawn");
    await expect(a2a.resumeMandate(w.b, w.bmd.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(a2a.startNegotiation(w.b, { mandateId: w.bmd.id, matchId: w.matchId })).rejects.toMatchObject({ code: "forbidden" });
    expect((await a2a.listSuspensions({ activeOnly: true })).some((s) => s.id === s1.id)).toBe(true);
    const lifted = await a2a.liftSuspension(s1.id, staff);
    expect(lifted.liftedAt).not.toBeNull();
    expect((await a2a.liftSuspension(s1.id, staff)).liftedAt).toBe(lifted.liftedAt);
    expect((await a2a.getMandate(w.b.businessId, w.bmd.id))!.status).toBe("paused");
    expect((await a2a.getMandate(w.b.businessId, w.bmd.id))!.autoAccept).toBe(false);
    await expect(a2a.liftSuspension("nope", staff)).rejects.toMatchObject({ code: "not_found" });
    const acts = (await a2a.listActivity(w.b.businessId)).map((a) => a.action);
    expect(acts).toContain("mandate_suspended");
    expect(acts).toContain("mandate_unsuspended");
  });
  it("a business suspension blocks both its own sends and sends against it, and withdraws its negotiations", async () => {
    const w = await world2();
    const n = await a2a.startNegotiation(w.b, { mandateId: w.bmd.id, matchId: w.matchId });
    await a2a.suspend({ kind: "business", targetId: w.s.businessId, reason: "kyc review in progress", by: staff });
    expect((await a2a.getNegotiation(w.b, n.id))!.status).toBe("withdrawn");
    await expect(a2a.sendNegotiationMessage(w.b, n.id, { type: "offer", offer: term() }, { idempotencyKey: "k" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(a2a.assertNotSuspended({ businessId: w.s.businessId })).rejects.toMatchObject({ code: "forbidden" });
    await expect(a2a.assertNotSuspended({ businessId: w.b.businessId })).resolves.toBeUndefined();
  });
  it("an API key suspension blocks that key only", async () => {
    const w = await world2();
    const n = await a2a.startNegotiation(w.b, { mandateId: w.bmd.id, matchId: w.matchId });
    await a2a.suspend({ kind: "api_key", targetId: "bad-key", reason: "credential leak suspected", by: staff });
    await expect(a2a.sendNegotiationMessage(w.b, n.id, { type: "offer", offer: term() }, { idempotencyKey: "k", via: { kind: "external_agent", apiKeyId: "bad-key" } })).rejects.toMatchObject({ code: "forbidden" });
    await expect(a2a.startNegotiation(w.b, { mandateId: w.bmd.id, matchId: w.matchId }, { kind: "external_agent", apiKeyId: "bad-key" })).rejects.toMatchObject({ code: "forbidden" });
    const ok = await a2a.sendNegotiationMessage(w.b, n.id, { type: "offer", offer: term() }, { idempotencyKey: "k", via: { kind: "external_agent", apiKeyId: "good-key" } });
    expect(ok.round).toBe(1);
  });
});

describe("rate limits and anomaly flags", () => {
  it("per-key limit returns rate_limited; per-business limit too; internal agents are not throttled by the key limit", async () => {
    vi.stubEnv("A2A_KEY_MSGS_PER_MIN", "2");
    const w = await world2();
    const n = await a2a.startNegotiation(w.b, { mandateId: w.bmd.id, matchId: w.matchId });
    const via = { kind: "external_agent" as const, apiKeyId: `rl-${n.id}` };
    await a2a.sendNegotiationMessage(w.b, n.id, { type: "offer", offer: term() }, { idempotencyKey: "a", via });
    await a2a.sendNegotiationMessage(w.b, n.id, { type: "offer", offer: term({ pricePaise: 4400 }) }, { idempotencyKey: "b", via }).catch(() => null);
    await expect(a2a.sendNegotiationMessage(w.b, n.id, { type: "offer", offer: term({ pricePaise: 4500 }) }, { idempotencyKey: "c", via })).rejects.toMatchObject({ code: "rate_limited" });
    vi.stubEnv("A2A_KEY_MSGS_PER_MIN", "60");
    vi.stubEnv("A2A_BUSINESS_MSGS_PER_MIN", "1");
    const w2 = await world2();
    const n2 = await a2a.startNegotiation(w2.b, { mandateId: w2.bmd.id, matchId: w2.matchId });
    await a2a.sendNegotiationMessage(w2.b, n2.id, { type: "offer", offer: term() }, { idempotencyKey: "a" });
    await expect(a2a.sendNegotiationMessage(w2.b, n2.id, { type: "withdraw" }, { idempotencyKey: "b" })).rejects.toMatchObject({ code: "rate_limited" });
    vi.stubEnv("A2A_BUSINESS_MSGS_PER_MIN", "120");
    vi.stubEnv("A2A_STARTS_PER_HOUR", "1");
    const w3 = await world2();
    await a2a.startNegotiation(w3.b, { mandateId: w3.bmd.id, matchId: w3.matchId });
    const again = await matchFor(w3.b, w3.s);
    await expect(a2a.startNegotiation(w3.b, { mandateId: w3.bmd.id, matchId: again.matchId })).rejects.toMatchObject({ code: "rate_limited" });
  });
  it("flags the 3rd identical message in a minute, refuses the 6th; repeated out-of-bounds attempts are flagged", async () => {
    const w = await world2();
    const n = await a2a.startNegotiation(w.b, { mandateId: w.bmd.id, matchId: w.matchId });
    const via = { kind: "external_agent" as const, apiKeyId: "anom-key" };
    const send = (key: string) => a2a.sendNegotiationMessage(w.b, n.id, { type: "offer", offer: term() }, { idempotencyKey: key, via }).catch((e) => e);
    expect((await send("1")).round).toBe(1);
    await send("2");
    await send("3");
    let an = await a2a.listAnomalies({ businessId: w.b.businessId });
    expect(an.some((a) => a.kind === "rapid_identical_offers" && a.negotiationId === n.id && a.apiKeyId === "anom-key")).toBe(true);
    expect((await a2a.getNegotiation(w.b, n.id))!.flagged).toBe(true);
    await send("4");
    await send("5");
    expect(await send("6")).toMatchObject({ code: "rate_limited" });
    expect((await a2a.listActivity(w.b.businessId)).some((a) => a.action === "anomaly_flagged")).toBe(true);

    const w2 = await world2();
    const n2 = await a2a.startNegotiation(w2.b, { mandateId: w2.bmd.id, matchId: w2.matchId });
    for (let i = 0; i < 6; i++) {
      await a2a.sendNegotiationMessage(w2.b, n2.id, { type: "offer", offer: term({ pricePaise: 9000 + i }) }, { idempotencyKey: `x${i}`, via: { kind: "external_agent", apiKeyId: "oob" } }).catch(() => null);
    }
    an = await a2a.listAnomalies({ businessId: w2.b.businessId });
    expect(an.some((a) => a.kind === "repeated_out_of_bounds")).toBe(true);
    expect((await a2a.listAnomalies({ limit: 5 })).length).toBeGreaterThan(0);
    expect(events).toBeDefined();
    expect(await prisma.agentAnomaly.count({ where: { businessId: w2.b.businessId } })).toBeGreaterThan(0);
  });
});
