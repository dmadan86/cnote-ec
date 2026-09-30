// Pure, framework-free rules for ADR-020: the typed offer/counter/accept protocol, its state machine and the server-side bounds
// both sides are held to. No I/O so everything is property-testable. Nothing here ever reads the OTHER side's private bounds
// to explain a rejection: violations name only the sender's own limits (an agent must never learn the counterparty's floor/ceiling).
import { z } from "zod";

export type Side = "buyer" | "seller";
export const other = (s: Side): Side => (s === "buyer" ? "seller" : "buyer");

// ---------------------------------------------------------------- typed terms
export const MAX_PRICE_PAISE = 10_000_000_000_00;
const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

/** One offer's typed terms. Money is integer paise per unit. */
export const offerSchema = z.object({
  pricePaise: z.number().int().positive().max(MAX_PRICE_PAISE),
  quantity: z.number().int().positive().max(2_000_000_000),
  unit: z.string().trim().min(1).max(20),
  leadTimeDays: z.number().int().min(0).max(365),
  deliveryTerms: optText(300),
  /** last day (inclusive, YYYY-MM-DD) the offer can be accepted */
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(v)), "Enter a valid date"),
  paymentTerms: optText(200),
});
export type Offer = z.output<typeof offerSchema>;
export type OfferInput = z.input<typeof offerSchema>;

export const MESSAGE_TYPES = ["offer", "counter", "accept", "reject", "withdraw"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** A protocol message. Offer/counter carry terms; accept/reject/withdraw carry none (accept always refers to the standing offer). */
export const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("offer"), offer: offerSchema }),
  z.object({ type: z.literal("counter"), offer: offerSchema }),
  z.object({ type: z.literal("accept") }),
  z.object({ type: z.literal("reject") }),
  z.object({ type: z.literal("withdraw") }),
]);
export type ProtocolMessage = z.output<typeof messageSchema>;
export type ProtocolMessageInput = z.input<typeof messageSchema>;

// ---------------------------------------------------------------- private bounds (snapshotted per negotiation)
export interface BuyerPrivate {
  maxPricePaise: number;
  targetPricePaise: number | null;
  maxLeadTimeDays: number | null;
  /** the mandated quantity: the buyer agent never offers or accepts a different one */
  quantity: number | null;
  unit: string;
  deliveryTerms: string | null;
  paymentTerms: string | null;
  autoAccept: boolean;
  autoAcceptLimitPaise: number | null;
}
export interface SellerPrivate {
  /** effective floor = max(price-book floor, mandate floor, max-discount floor) */
  floorPricePaise: number;
  /** tier price for the RFQ quantity: where the seller agent opens */
  basePricePaise: number;
  minLeadTimeDays: number;
  leadTimeDays: number;
  moq: number | null;
  capacityQty: number | null;
  /** quantity the enquiry asks for (where a seller-initiated opening offer starts) */
  rfqQuantity: number | null;
  unit: string;
  deliveryTerms: string | null;
  paymentTerms: string | null;
  validityDays: number;
  autoAccept: boolean;
  autoAcceptLimitPaise: number | null;
}
export type Private = { buyer: BuyerPrivate; seller: SellerPrivate };

export interface BoundsResult { ok: boolean; violations: string[] }
const res = (violations: string[]): BoundsResult => ({ ok: violations.length === 0, violations });

/** Are these offer terms inside the SENDER's own bounds? Violations mention only the sender's own limits. */
export function checkOwnBounds(side: Side, o: Offer, priv: Private): BoundsResult {
  const v: string[] = [];
  if (side === "buyer") {
    const b = priv.buyer;
    if (o.pricePaise > b.maxPricePaise) v.push("Price is above your mandate's maximum price.");
    if (b.maxLeadTimeDays != null && o.leadTimeDays > b.maxLeadTimeDays) v.push("Lead time is longer than your mandate allows.");
    if (b.quantity != null && o.quantity !== b.quantity) v.push("Quantity differs from your mandate's quantity.");
  } else {
    const s = priv.seller;
    if (o.pricePaise < s.floorPricePaise) v.push("Price is below your mandate's floor.");
    if (o.leadTimeDays < s.minLeadTimeDays) v.push("Lead time is shorter than your price book allows.");
    if (s.moq != null && o.quantity < s.moq) v.push("Quantity is below your minimum order quantity.");
    if (s.capacityQty != null && o.quantity > s.capacityQty) v.push("Quantity is above your mandate's capacity.");
  }
  return res(v);
}

/** Auto-accept is allowed only when the side opted in AND the terms are inside its (tighter) auto-accept limit and its own bounds. */
export function withinAutoAccept(side: Side, o: Offer, priv: Private): boolean {
  if (!checkOwnBounds(side, o, priv).ok) return false;
  if (side === "buyer") return priv.buyer.autoAccept && priv.buyer.autoAcceptLimitPaise != null && o.pricePaise <= Math.min(priv.buyer.autoAcceptLimitPaise, priv.buyer.maxPricePaise);
  return priv.seller.autoAccept && priv.seller.autoAcceptLimitPaise != null && o.pricePaise >= Math.max(priv.seller.autoAcceptLimitPaise, priv.seller.floorPricePaise);
}

// ---------------------------------------------------------------- state machine
export type Status = "open" | "agreed" | "accepted" | "rejected" | "withdrawn" | "expired";
export const TERMINAL: Status[] = ["accepted", "rejected", "withdrawn", "expired"];

export interface HistoryOffer extends Offer { by: Side }
export interface State {
  status: Status;
  round: number;
  maxRounds: number;
  turn: Side | null;
  lastOffer: HistoryOffer | null;
  history: HistoryOffer[];
  expiresAt: Date;
}
export type StepError = "closed" | "expired" | "not_your_turn" | "no_standing_offer" | "opening_only" | "own_offer" | "max_rounds" | "out_of_bounds" | "not_conceding" | "offer_expired" | "invalid_validity";
export type StepResult =
  | { ok: true; state: State; closes: "agreed" | "rejected" | "withdrawn" | null }
  | { ok: false; error: StepError; violations: string[] };

const fail = (error: StepError, violations: string[] = []): StepResult => ({ ok: false, error, violations });
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const MAX_VALIDITY_DAYS = 90;

/** validUntil must be today or later and within 90 days. */
export function validityProblem(validUntil: string, now: Date): string | null {
  const today = isoDay(now);
  if (validUntil < today) return "The offer's validity date has already passed.";
  if (Date.parse(validUntil) - Date.parse(today) > MAX_VALIDITY_DAYS * 86_400_000) return `Validity may be at most ${MAX_VALIDITY_DAYS} days.`;
  return null;
}

/**
 * The protocol. `side` acts on `state` with `msg` at `now`.
 *  - withdraw: either side, any time while the negotiation is open.
 *  - offer: only as the opening message (no standing offer); counter: only against the other side's standing offer.
 *  - accept / reject: only against the other side's standing offer, only on your turn.
 *  - offers/counters must be inside the sender's OWN bounds, must not retreat from the sender's previous price (a buyer never lowers,
 *    a seller never raises) and may not exceed maxRounds. Accept re-checks the acceptor's own bounds and the offer's validity.
 * Enforced identically for internal agents, external agents and humans: who sent it never matters.
 */
export function step(state: State, side: Side, msg: ProtocolMessage, priv: Private, now: Date): StepResult {
  if (state.status !== "open") return fail("closed");
  if (now.getTime() > state.expiresAt.getTime()) return fail("expired");
  if (msg.type === "withdraw") return { ok: true, closes: "withdrawn", state: { ...state, status: "withdrawn", turn: null } };
  if (state.turn !== side) return fail("not_your_turn");

  if (msg.type === "offer" || msg.type === "counter") {
    if (msg.type === "offer" && state.lastOffer) return fail("opening_only");
    if (msg.type === "counter" && !state.lastOffer) return fail("no_standing_offer");
    if (state.round + 1 > state.maxRounds) return fail("max_rounds");
    const vp = validityProblem(msg.offer.validUntil, now);
    if (vp) return fail("invalid_validity", [vp]);
    const bounds = checkOwnBounds(side, msg.offer, priv);
    if (!bounds.ok) return fail("out_of_bounds", bounds.violations);
    const own = [...state.history].reverse().find((h) => h.by === side);
    if (own) {
      const retreat = side === "buyer" ? msg.offer.pricePaise < own.pricePaise : msg.offer.pricePaise > own.pricePaise;
      if (retreat) return fail("not_conceding", [side === "buyer" ? "A buyer offer cannot go below your previous offer." : "A seller offer cannot go above your previous offer."]);
    }
    const offer: HistoryOffer = { ...msg.offer, by: side };
    return { ok: true, closes: null, state: { ...state, round: state.round + 1, turn: other(side), lastOffer: offer, history: [...state.history, offer] } };
  }

  // accept / reject act on the counterparty's standing offer
  const standing = state.lastOffer;
  if (!standing) return fail("no_standing_offer");
  if (standing.by === side) return fail("own_offer");
  if (msg.type === "reject") return { ok: true, closes: "rejected", state: { ...state, status: "rejected", turn: null } };
  const vp = validityProblem(standing.validUntil, now);
  if (vp) return fail("offer_expired", [vp]);
  const bounds = checkOwnBounds(side, standing, priv);
  if (!bounds.ok) return fail("out_of_bounds", bounds.violations);
  return { ok: true, closes: "agreed", state: { ...state, status: "agreed", turn: null } };
}

// ---------------------------------------------------------------- internal agent strategies (deterministic)
export type AgentAction = { type: "offer" | "counter"; offer: Offer } | { type: "accept" } | { type: "reject" } | { type: "withdraw" };
const addDays = (now: Date, days: number) => isoDay(new Date(now.getTime() + days * 86_400_000));

/** Concede half of the remaining gap each round (at least 1 paise) but never past the side's own limit. */
function towards(from: number, to: number): number {
  if (from === to) return from;
  const half = Math.max(1, Math.ceil(Math.abs(to - from) / 2));
  return from < to ? Math.min(to, from + half) : Math.max(to, from - half);
}
const CLOSE_ENOUGH = 0.02;

/** Last line of defence for the agents themselves: never emit an offer the server would refuse; withdraw instead (e.g. an unsatisfiable mandate). */
function guarded(side: Side, a: AgentAction, priv: Private): AgentAction {
  return (a.type === "offer" || a.type === "counter") && !checkOwnBounds(side, a.offer, priv).ok ? { type: "withdraw" } : a;
}

/**
 * The buyer agent's move. Opens at the target (else 80% of the maximum), concedes half the gap towards the seller's price each
 * round, accepts when the seller is within 2% of the buyer's last offer or (on the last round) whenever the terms fit the mandate.
 * Every offer it makes is inside the buyer's bounds by construction; accept is only chosen when checkOwnBounds passes.
 */
export function buyerAgentMove(state: State, priv: Private, now: Date, validityDays = 3): AgentAction {
  const b = priv.buyer;
  const standing = state.lastOffer;
  const validUntil = addDays(now, validityDays);
  const qty = b.quantity ?? standing?.quantity ?? 1;
  const mine = [...state.history].reverse().find((h) => h.by === "buyer");
  const lead = (l: number | null) => (b.maxLeadTimeDays != null ? Math.min(l ?? b.maxLeadTimeDays, b.maxLeadTimeDays) : (l ?? 7));
  const make = (pricePaise: number, leadFrom: number | null): Offer => ({
    pricePaise, quantity: qty, unit: b.unit, leadTimeDays: lead(leadFrom), deliveryTerms: b.deliveryTerms, validUntil, paymentTerms: b.paymentTerms,
  });
  if (!standing) {
    const open = Math.max(1, Math.min(b.maxPricePaise, b.targetPricePaise ?? Math.round(b.maxPricePaise * 0.8)));
    return guarded("buyer", { type: "offer", offer: make(open, null) }, priv);
  }
  const fits = checkOwnBounds("buyer", standing, priv).ok;
  const lastRound = state.round + 1 > state.maxRounds;
  const myLast = mine?.pricePaise ?? 0;
  if (fits && (standing.pricePaise <= myLast * (1 + CLOSE_ENOUGH) || lastRound)) return { type: "accept" };
  if (lastRound) return { type: "reject" };
  const target = Math.min(standing.pricePaise, b.maxPricePaise);
  const next = Math.max(myLast, towards(myLast || target, target));
  // Even at the ceiling the seller is still too far away in lead time or quantity: a counter cannot fix it unless we restate our own terms.
  return guarded("buyer", { type: "counter", offer: make(Math.min(next, b.maxPricePaise), standing.leadTimeDays) }, priv);
}

/**
 * The seller agent's move. Opens at the price-book tier price, concedes half the gap towards the buyer each round, never below the
 * floor; accepts when the buyer is within 2% of the seller's last price or (last round) whenever the terms fit its bounds.
 */
export function sellerAgentMove(state: State, priv: Private, now: Date): AgentAction {
  const s = priv.seller;
  const standing = state.lastOffer;
  const validUntil = addDays(now, s.validityDays);
  const mine = [...state.history].reverse().find((h) => h.by === "seller");
  const clampQty = (q: number) => Math.max(s.moq ?? 1, Math.min(q, s.capacityQty ?? q));
  const make = (pricePaise: number, qty: number, askLead: number | null): Offer => ({
    pricePaise: Math.max(pricePaise, s.floorPricePaise), quantity: clampQty(qty), unit: s.unit, leadTimeDays: Math.max(askLead ?? s.leadTimeDays, s.minLeadTimeDays),
    deliveryTerms: s.deliveryTerms, validUntil, paymentTerms: s.paymentTerms,
  });
  if (!standing) return guarded("seller", { type: "offer", offer: make(s.basePricePaise, s.rfqQuantity ?? s.moq ?? 1, null) }, priv);
  const fits = checkOwnBounds("seller", standing, priv).ok;
  const lastRound = state.round + 1 > state.maxRounds;
  const myLast = mine?.pricePaise ?? s.basePricePaise;
  if (fits && (standing.pricePaise >= myLast * (1 - CLOSE_ENOUGH) || lastRound)) return { type: "accept" };
  if (lastRound) return { type: "reject" };
  const next = Math.min(myLast, Math.max(towards(myLast, Math.max(standing.pricePaise, s.floorPricePaise)), s.floorPricePaise));
  return guarded("seller", { type: "counter", offer: make(next, standing.quantity, standing.leadTimeDays) }, priv);
}

// ---------------------------------------------------------------- misc pure helpers
export const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Stable fingerprint of a message's content (anomaly detection: rapid identical offers). */
export function fingerprint(side: Side, msg: ProtocolMessage): string {
  if (msg.type === "offer" || msg.type === "counter") {
    const o = msg.offer;
    return [side, msg.type, o.pricePaise, o.quantity, o.unit, o.leadTimeDays, o.deliveryTerms ?? "", o.validUntil, o.paymentTerms ?? ""].join("|");
  }
  return `${side}|${msg.type}`;
}

/** The counterparty-safe projection of an offer: terms only. */
export const offerTerms = (o: HistoryOffer): Offer & { by: Side } => ({ ...o });
