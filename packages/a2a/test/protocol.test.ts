import { describe, expect, it } from "vitest";
import {
  buyerAgentMove, checkOwnBounds, fingerprint, messageSchema, offerSchema, other, step, validityProblem, withinAutoAccept,
  type HistoryOffer, type Offer, type Private, type ProtocolMessage, type State,
} from "../src/protocol";

const NOW = new Date("2026-09-30T10:00:00Z");
export const priv = (over: { buyer?: Partial<Private["buyer"]>; seller?: Partial<Private["seller"]> } = {}): Private => ({
  buyer: { maxPricePaise: 5000, targetPricePaise: 4000, maxLeadTimeDays: 10, quantity: 100, unit: "pcs", deliveryTerms: null, paymentTerms: null, autoAccept: false, autoAcceptLimitPaise: null, ...over.buyer },
  seller: { floorPricePaise: 4200, basePricePaise: 5500, minLeadTimeDays: 5, leadTimeDays: 7, moq: 50, capacityQty: 1000, rfqQuantity: 100, unit: "pcs", deliveryTerms: null, paymentTerms: null, validityDays: 7, autoAccept: false, autoAcceptLimitPaise: null, ...over.seller },
});
export const offer = (over: Partial<Offer> = {}): Offer => ({ pricePaise: 4500, quantity: 100, unit: "pcs", leadTimeDays: 7, deliveryTerms: null, validUntil: "2026-10-05", paymentTerms: null, ...over });
export const open = (over: Partial<State> = {}): State => ({ status: "open", round: 0, maxRounds: 4, turn: "buyer", lastOffer: null, history: [], expiresAt: new Date("2026-10-01T10:00:00Z"), ...over });
const withOffer = (by: "buyer" | "seller", o: Partial<Offer> = {}, round = 1, turn?: "buyer" | "seller"): State => {
  const h: HistoryOffer = { ...offer(o), by };
  return open({ round, turn: turn ?? other(by), lastOffer: h, history: [h] });
};
const msg = (type: "offer" | "counter", o: Partial<Offer> = {}): ProtocolMessage => ({ type, offer: offer(o) });

describe("typed terms", () => {
  it("parses offers and trims optional text", () => {
    const p = offerSchema.parse({ ...offer(), deliveryTerms: "  ex-works ", paymentTerms: "" });
    expect(p.deliveryTerms).toBe("ex-works");
    expect(p.paymentTerms).toBeNull();
  });
  it("rejects free text, floats, zero and bad dates", () => {
    expect(offerSchema.safeParse({ ...offer(), pricePaise: 10.5 }).success).toBe(false);
    expect(offerSchema.safeParse({ ...offer(), pricePaise: 0 }).success).toBe(false);
    expect(offerSchema.safeParse({ ...offer(), validUntil: "tomorrow" }).success).toBe(false);
    expect(offerSchema.safeParse({ ...offer(), validUntil: "2026-13-45" }).success).toBe(false);
    expect(messageSchema.safeParse({ type: "haggle" }).success).toBe(false);
    expect(messageSchema.safeParse({ type: "offer" }).success).toBe(false);
    expect(messageSchema.safeParse({ type: "accept" }).success).toBe(true);
  });
  it("validity window", () => {
    expect(validityProblem("2026-09-29", NOW)).toMatch(/passed/);
    expect(validityProblem("2026-09-30", NOW)).toBeNull();
    expect(validityProblem("2027-01-30", NOW)).toMatch(/at most/);
  });
});

describe("bounds (own side only)", () => {
  it("buyer: price, lead time, quantity", () => {
    const p = priv();
    expect(checkOwnBounds("buyer", offer({ pricePaise: 5001 }), p).violations).toEqual(["Price is above your mandate's maximum price."]);
    expect(checkOwnBounds("buyer", offer({ leadTimeDays: 11 }), p).ok).toBe(false);
    expect(checkOwnBounds("buyer", offer({ quantity: 99 }), p).ok).toBe(false);
    expect(checkOwnBounds("buyer", offer({ pricePaise: 5000 }), p).ok).toBe(true);
    expect(checkOwnBounds("buyer", offer({ quantity: 7 }), priv({ buyer: { quantity: null, maxLeadTimeDays: null } })).ok).toBe(true);
  });
  it("seller: floor, lead time, moq, capacity", () => {
    const p = priv();
    expect(checkOwnBounds("seller", offer({ pricePaise: 4199 }), p).ok).toBe(false);
    expect(checkOwnBounds("seller", offer({ leadTimeDays: 4 }), p).ok).toBe(false);
    expect(checkOwnBounds("seller", offer({ quantity: 49 }), p).ok).toBe(false);
    expect(checkOwnBounds("seller", offer({ quantity: 1001 }), p).ok).toBe(false);
    expect(checkOwnBounds("seller", offer({ pricePaise: 4200 }), p).ok).toBe(true);
    expect(checkOwnBounds("seller", offer({ quantity: 5000 }), priv({ seller: { capacityQty: null, moq: null } })).ok).toBe(true);
  });
  it("violation texts never contain numbers (no leaking of the other side's limits)", () => {
    const p = priv();
    const all = [
      ...checkOwnBounds("buyer", offer({ pricePaise: 9999, leadTimeDays: 99, quantity: 1 }), p).violations,
      ...checkOwnBounds("seller", offer({ pricePaise: 1, leadTimeDays: 0, quantity: 1 }), p).violations,
    ];
    expect(all.length).toBeGreaterThan(4);
    for (const v of all) expect(v).not.toMatch(/\d/);
  });
});

describe("auto-accept bounds", () => {
  it("needs the opt-in AND a limit AND terms inside both the limit and the hard bounds", () => {
    const o = offer({ pricePaise: 4400 });
    expect(withinAutoAccept("buyer", o, priv())).toBe(false);
    expect(withinAutoAccept("buyer", o, priv({ buyer: { autoAccept: true, autoAcceptLimitPaise: null } }))).toBe(false);
    expect(withinAutoAccept("buyer", o, priv({ buyer: { autoAccept: true, autoAcceptLimitPaise: 4400 } }))).toBe(true);
    expect(withinAutoAccept("buyer", offer({ pricePaise: 4401 }), priv({ buyer: { autoAccept: true, autoAcceptLimitPaise: 4400 } }))).toBe(false);
    expect(withinAutoAccept("buyer", o, priv({ buyer: { autoAccept: true, autoAcceptLimitPaise: 9000, maxPricePaise: 4300 } }))).toBe(false);
    expect(withinAutoAccept("seller", o, priv({ seller: { autoAccept: true, autoAcceptLimitPaise: 4400 } }))).toBe(true);
    expect(withinAutoAccept("seller", offer({ pricePaise: 4399 }), priv({ seller: { autoAccept: true, autoAcceptLimitPaise: 4400 } }))).toBe(false);
    expect(withinAutoAccept("seller", offer({ pricePaise: 4300 }), priv({ seller: { autoAccept: true, autoAcceptLimitPaise: 100 } }))).toBe(true);
    expect(withinAutoAccept("seller", offer({ pricePaise: 4100 }), priv({ seller: { autoAccept: true, autoAcceptLimitPaise: 100 } }))).toBe(false);
    expect(withinAutoAccept("seller", o, priv({ seller: { autoAccept: false, autoAcceptLimitPaise: 4400 } }))).toBe(false);
  });
});

describe("state machine", () => {
  const p = priv();
  it("opening offer, then counters alternate; round counts", () => {
    const r1 = step(open(), "buyer", msg("offer", { pricePaise: 4000 }), p, NOW);
    expect(r1.ok && r1.state.round).toBe(1);
    expect(r1.ok && r1.state.turn).toBe("seller");
    const r2 = step((r1 as { ok: true; state: State }).state, "seller", msg("counter", { pricePaise: 5000 }), p, NOW);
    expect(r2.ok && r2.state.turn).toBe("buyer");
    expect(r2.ok && r2.state.history).toHaveLength(2);
  });
  it("turn order, opening-only, no-standing-offer, own offer", () => {
    expect(step(open(), "seller", msg("offer"), p, NOW)).toMatchObject({ ok: false, error: "not_your_turn" });
    expect(step(open(), "buyer", msg("counter"), p, NOW)).toMatchObject({ ok: false, error: "no_standing_offer" });
    expect(step(open(), "buyer", { type: "accept" }, p, NOW)).toMatchObject({ ok: false, error: "no_standing_offer" });
    expect(step(withOffer("seller", {}, 1, "seller"), "seller", { type: "accept" }, p, NOW)).toMatchObject({ ok: false, error: "own_offer" });
    expect(step(withOffer("seller"), "buyer", msg("offer"), p, NOW)).toMatchObject({ ok: false, error: "opening_only" });
  });
  it("out-of-bounds offers are rejected whoever sends them", () => {
    expect(step(open(), "buyer", msg("offer", { pricePaise: 9000 }), p, NOW)).toMatchObject({ ok: false, error: "out_of_bounds" });
    expect(step(withOffer("buyer", { pricePaise: 4000 }), "seller", msg("counter", { pricePaise: 4000 }), p, NOW)).toMatchObject({ ok: false, error: "out_of_bounds" });
  });
  it("no retreat: buyer never lowers, seller never raises", () => {
    const s = open({ round: 2, turn: "buyer", history: [{ ...offer({ pricePaise: 4400 }), by: "buyer" }, { ...offer({ pricePaise: 4900 }), by: "seller" }], lastOffer: { ...offer({ pricePaise: 4900 }), by: "seller" } });
    expect(step(s, "buyer", msg("counter", { pricePaise: 4300 }), p, NOW)).toMatchObject({ ok: false, error: "not_conceding" });
    expect(step(s, "buyer", msg("counter", { pricePaise: 4400 }), p, NOW).ok).toBe(true);
    const t = open({ round: 3, turn: "seller", history: [{ ...offer({ pricePaise: 4400 }), by: "buyer" }, { ...offer({ pricePaise: 4900 }), by: "seller" }, { ...offer({ pricePaise: 4500 }), by: "buyer" }], lastOffer: { ...offer({ pricePaise: 4500 }), by: "buyer" } });
    expect(step(t, "seller", msg("counter", { pricePaise: 4950 }), p, NOW)).toMatchObject({ ok: false, error: "not_conceding" });
  });
  it("max rounds: the last offer can only be accepted, rejected or withdrawn", () => {
    const s = withOffer("buyer", { pricePaise: 4500 }, 4, "seller");
    expect(step(s, "seller", msg("counter", { pricePaise: 4600 }), p, NOW)).toMatchObject({ ok: false, error: "max_rounds" });
    expect(step(s, "seller", { type: "accept" }, p, NOW)).toMatchObject({ ok: true, closes: "agreed" });
    expect(step(s, "seller", { type: "reject" }, p, NOW)).toMatchObject({ ok: true, closes: "rejected" });
  });
  it("accept re-checks the acceptor's bounds and the offer's validity", () => {
    expect(step(withOffer("seller", { pricePaise: 5100 }), "buyer", { type: "accept" }, p, NOW)).toMatchObject({ ok: false, error: "out_of_bounds" });
    expect(step(withOffer("seller", { validUntil: "2026-09-29" }), "buyer", { type: "accept" }, p, NOW)).toMatchObject({ ok: false, error: "offer_expired" });
    expect(step(withOffer("seller", { pricePaise: 4800 }), "buyer", { type: "accept" }, p, NOW)).toMatchObject({ ok: true, closes: "agreed", state: { status: "agreed", turn: null } });
  });
  it("invalid validity on offers", () => {
    expect(step(open(), "buyer", msg("offer", { validUntil: "2026-01-01" }), p, NOW)).toMatchObject({ ok: false, error: "invalid_validity" });
  });
  it("closed and expired states refuse everything; withdraw works for either side any time", () => {
    expect(step(open({ status: "agreed" }), "buyer", { type: "withdraw" }, p, NOW)).toMatchObject({ ok: false, error: "closed" });
    expect(step(open({ expiresAt: new Date("2026-09-30T09:59:59Z") }), "buyer", msg("offer"), p, NOW)).toMatchObject({ ok: false, error: "expired" });
    expect(step(open(), "seller", { type: "withdraw" }, p, NOW)).toMatchObject({ ok: true, closes: "withdrawn", state: { status: "withdrawn" } });
  });
  it("reject closes", () => {
    expect(step(withOffer("seller"), "buyer", { type: "reject" }, p, NOW)).toMatchObject({ ok: true, closes: "rejected" });
  });
});

describe("agent strategies and fingerprint", () => {
  it("buyer opens at target, else 80% of max", () => {
    const a = buyerAgentMove(open(), priv(), NOW);
    expect(a).toMatchObject({ type: "offer", offer: { pricePaise: 4000, quantity: 100, unit: "pcs" } });
    const b = buyerAgentMove(open(), priv({ buyer: { targetPricePaise: null, maxLeadTimeDays: null } }), NOW);
    expect(b).toMatchObject({ type: "offer", offer: { pricePaise: 4000 } });
  });
  it("fingerprints are stable per content", () => {
    expect(fingerprint("buyer", msg("offer"))).toBe(fingerprint("buyer", msg("offer")));
    expect(fingerprint("buyer", msg("offer"))).not.toBe(fingerprint("buyer", msg("offer", { pricePaise: 1 })));
    expect(fingerprint("seller", { type: "accept" })).toBe("seller|accept");
  });
});
