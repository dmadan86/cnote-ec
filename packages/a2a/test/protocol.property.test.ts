import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buyerAgentMove, checkOwnBounds, other, sellerAgentMove, step, type AgentAction, type Offer, type Private, type ProtocolMessage, type Side, type State } from "../src/protocol";

const NOW = new Date("2026-09-30T10:00:00Z");
const EXP = new Date("2026-10-30T10:00:00Z");

const privArb: fc.Arbitrary<Private> = fc
  .record({
    bMax: fc.integer({ min: 100, max: 20_000 }), bTargetPct: fc.integer({ min: 30, max: 100 }), bLead: fc.option(fc.integer({ min: 1, max: 60 }), { nil: null }), bQty: fc.integer({ min: 1, max: 500 }),
    sFloor: fc.integer({ min: 50, max: 20_000 }), sBaseMul: fc.integer({ min: 100, max: 250 }), sMinLead: fc.integer({ min: 0, max: 30 }), sMoq: fc.option(fc.integer({ min: 1, max: 600 }), { nil: null }),
    sCap: fc.option(fc.integer({ min: 1, max: 900 }), { nil: null }), maxRounds: fc.integer({ min: 2, max: 10 }),
  })
  .map((r): Private => ({
    buyer: { maxPricePaise: r.bMax, targetPricePaise: Math.max(1, Math.floor((r.bMax * r.bTargetPct) / 100)), maxLeadTimeDays: r.bLead, quantity: r.bQty, unit: "pcs", deliveryTerms: null, paymentTerms: null, autoAccept: false, autoAcceptLimitPaise: null },
    seller: { floorPricePaise: r.sFloor, basePricePaise: Math.ceil((r.sFloor * r.sBaseMul) / 100), minLeadTimeDays: r.sMinLead, leadTimeDays: r.sMinLead + 2, moq: r.sMoq, capacityQty: r.sCap, rfqQuantity: r.bQty, unit: "pcs", deliveryTerms: null, paymentTerms: null, validityDays: 7, autoAccept: false, autoAcceptLimitPaise: null },
  }));

function simulate(priv: Private, maxRounds: number, first: Side) {
  let state: State = { status: "open", round: 0, maxRounds, turn: first, lastOffer: null, history: [], expiresAt: EXP };
  const log: { side: Side; msg: ProtocolMessage }[] = [];
  for (let i = 0; i < maxRounds * 3 + 6 && state.status === "open"; i++) {
    const side = state.turn!;
    const a: AgentAction = side === "buyer" ? buyerAgentMove(state, priv, NOW) : sellerAgentMove(state, priv, NOW);
    const m: ProtocolMessage = a.type === "offer" || a.type === "counter" ? { type: a.type, offer: a.offer } : { type: a.type };
    const r = step(state, side, m, priv, NOW);
    log.push({ side, msg: m });
    if (!r.ok) return { state, log, refused: { side, msg: m, error: r.error } };
    state = r.state;
  }
  return { state, log, refused: null };
}

describe("protocol properties", () => {
  it("two internal agents never break their own bounds, never get refused, and always terminate", () => {
    fc.assert(
      fc.property(privArb, fc.constantFrom<Side>("buyer", "seller"), fc.integer({ min: 2, max: 10 }), (priv, first, maxRounds) => {
        const { state, log, refused } = simulate(priv, maxRounds, first);
        // a refused move can only ever be the agent having no legal way to continue; it must never be a bounds violation
        if (refused) expect(["out_of_bounds"]).not.toContain(refused.error);
        expect(state.status).not.toBe("open");
        expect(log.length).toBeLessThanOrEqual(maxRounds + 2);
        expect(state.round).toBeLessThanOrEqual(maxRounds);
        for (const s of state.history) expect(checkOwnBounds(s.by, s, priv).ok).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it("an agreed deal is inside BOTH sides' bounds and is the standing offer of the other side", () => {
    let agreed = 0;
    fc.assert(
      fc.property(privArb, fc.integer({ min: 2, max: 10 }), (priv, maxRounds) => {
        const { state, log } = simulate(priv, maxRounds, "buyer");
        if (state.status !== "agreed") return;
        agreed++;
        const t = state.lastOffer!;
        expect(checkOwnBounds("buyer", t, priv).ok).toBe(true);
        expect(checkOwnBounds("seller", t, priv).ok).toBe(true);
        expect(log.at(-1)!.msg.type).toBe("accept");
        expect(log.at(-1)!.side).toBe(other(t.by));
      }),
      { numRuns: 400 },
    );
    expect(agreed).toBeGreaterThan(0);
  });

  it("any message that step accepts was inside the sender's own bounds; out-of-bounds is refused for any random offer", () => {
    const offerArb = fc.record({
      pricePaise: fc.integer({ min: 1, max: 40_000 }), quantity: fc.integer({ min: 1, max: 1500 }), unit: fc.constant("pcs"), leadTimeDays: fc.integer({ min: 0, max: 90 }),
      deliveryTerms: fc.constant(null), validUntil: fc.constant("2026-10-05"), paymentTerms: fc.constant(null),
    }) as fc.Arbitrary<Offer>;
    fc.assert(
      fc.property(privArb, offerArb, fc.constantFrom<Side>("buyer", "seller"), (priv, o, side) => {
        const state: State = { status: "open", round: 0, maxRounds: 6, turn: side, lastOffer: null, history: [], expiresAt: EXP };
        const r = step(state, side, { type: "offer", offer: o }, priv, NOW);
        const inBounds = checkOwnBounds(side, o, priv).ok;
        expect(r.ok).toBe(inBounds);
        if (!r.ok) for (const v of r.violations) expect(v).not.toMatch(/\d/);
      }),
      { numRuns: 500 },
    );
  });

  it("concessions are monotone: buyer prices never fall, seller prices never rise, within one negotiation", () => {
    fc.assert(
      fc.property(privArb, fc.integer({ min: 2, max: 10 }), (priv, maxRounds) => {
        const { state } = simulate(priv, maxRounds, "buyer");
        const prices = (s: Side) => state.history.filter((h) => h.by === s).map((h) => h.pricePaise);
        const b = prices("buyer"), se = prices("seller");
        for (let i = 1; i < b.length; i++) expect(b[i]!).toBeGreaterThanOrEqual(b[i - 1]!);
        for (let i = 1; i < se.length; i++) expect(se[i]!).toBeLessThanOrEqual(se[i - 1]!);
      }),
      { numRuns: 300 },
    );
  });

  it("closed negotiations accept nothing, for any message and side", () => {
    const msgs: ProtocolMessage[] = [{ type: "accept" }, { type: "reject" }, { type: "withdraw" }];
    fc.assert(
      fc.property(privArb, fc.constantFrom("agreed", "accepted", "rejected", "withdrawn", "expired") as fc.Arbitrary<State["status"]>, fc.constantFrom<Side>("buyer", "seller"), fc.constantFrom(...msgs), (priv, status, side, m) => {
        const r = step({ status, round: 1, maxRounds: 4, turn: null, lastOffer: null, history: [], expiresAt: EXP }, side, m, priv, NOW);
        expect(r.ok).toBe(false);
      }),
    );
  });
});
