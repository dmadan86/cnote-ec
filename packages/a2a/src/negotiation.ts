// Negotiations (ADR-020): the persisted, typed offer/counter/accept protocol between a buyer agent and a seller agent.
//  - every message goes through protocol.step(): bounds are enforced server-side no matter who sent it (internal agent, external
//    agent through an API key, or a person) and violations only ever name the SENDER's own limits
//  - idempotency key per (negotiation, side): a retried send returns the original result
//  - accept never commits anyone: it needs each principal's confirmation unless that side enabled auto-accept AND the terms sit
//    inside its auto-accept bounds; only then is a real Quote/Order created through enquiry's public functions
import * as ai from "@cnote/ai";
import { DomainError, emit } from "@cnote/core";
import { prisma, type AgentMandate, type AgentMessage, type AgentNegotiation, type Prisma, type Tx } from "@cnote/db";
import * as enquiry from "@cnote/enquiry";
import * as identity from "@cnote/identity";
import * as negotiation from "@cnote/negotiation";
import { big, isUuid, json, limits, logActivity, num, requireEnabled, type Actor, type Via } from "./common";
import {
  fingerprint, messageSchema, offerSchema, other, step, withinAutoAccept,
  type BuyerPrivate, type HistoryOffer, type Offer, type Private, type ProtocolMessageInput, type SellerPrivate, type Side, type State,
} from "./protocol";
import { scheduleAdvance, scheduleFinalise } from "./queue";
import { assertCanStart, assertNotSuspended, assertWithinRates, guardBehaviour } from "./safety";

type Confirmation = "pending" | "human" | "auto" | "declined";
const isDone = (c: Confirmation) => c === "human" || c === "auto";
const kindOfVia = (v?: Via) => (v?.kind === "external_agent" ? "external_agent" : v?.kind === "human" ? "human" : "internal_agent");

const privOf = (n: AgentNegotiation): Private => ({ buyer: n.buyerPrivate as unknown as BuyerPrivate, seller: n.sellerPrivate as unknown as SellerPrivate });
const rupees = (p: number) => `Rs ${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

// ---------------------------------------------------------------- views
export interface OfferView { pricePaise: number; quantity: number; unit: string; leadTimeDays: number; deliveryTerms: string | null; validUntil: string; paymentTerms: string | null }
export interface MessageView {
  seq: number;
  side: Side;
  type: AgentMessage["type"];
  offer: OfferView | null;
  /** agent = an internal agent, external_agent = a third-party agent through an API key, person = a human */
  actor: "agent" | "external_agent" | "person";
  mine: boolean;
  createdAt: string;
}
export interface NegotiationView {
  id: string;
  status: AgentNegotiation["status"];
  /** which side the requester is on (admin views use "buyer" with `admin: true`) */
  youAre: Side;
  admin: boolean;
  buyer: { businessId: string; name: string };
  seller: { businessId: string; name: string };
  enquiryId: string;
  matchId: string;
  round: number;
  maxRounds: number;
  turn: Side | null;
  lastOffer: (OfferView & { by: Side }) | null;
  agreed: OfferView | null;
  /** the requester's own confirmation state */
  yourConfirmation: Confirmation;
  /** counterparty: only whether they confirmed, never how (and never their bounds) */
  counterpartyConfirmed: boolean;
  buyerConfirmed: boolean;
  sellerConfirmed: boolean;
  canConfirm: boolean;
  /** the requester's own limits (from its own mandate snapshot); the counterparty's are never included */
  yourLimits: Record<string, unknown> | null;
  external: boolean;
  flagged: boolean;
  quoteId: string | null;
  orderId: string | null;
  realiseError: string | null;
  expiresAt: string;
  createdAt: string;
  closedAt: string | null;
  messages: MessageView[];
}

const toOfferView = (o: OfferRecord): OfferView => ({ pricePaise: o.pricePaise, quantity: o.quantity, unit: o.unit, leadTimeDays: o.leadTimeDays, deliveryTerms: o.deliveryTerms ?? null, validUntil: o.validUntil, paymentTerms: o.paymentTerms ?? null });
type OfferRecord = Offer & { by?: Side };

function offerOf(m: AgentMessage): HistoryOffer | null {
  if ((m.type !== "offer" && m.type !== "counter") || m.pricePaise == null || m.quantity == null) return null;
  const t = (m.terms ?? {}) as Record<string, unknown>;
  return {
    by: m.side, pricePaise: Number(m.pricePaise), quantity: m.quantity, unit: String(t.unit ?? ""), leadTimeDays: Number(t.leadTimeDays ?? 0),
    deliveryTerms: (t.deliveryTerms as string | null) ?? null, validUntil: String(t.validUntil ?? ""), paymentTerms: (t.paymentTerms as string | null) ?? null,
  };
}
const stateOf = (n: AgentNegotiation, msgs: AgentMessage[]): State => {
  const history = msgs.map(offerOf).filter((o): o is HistoryOffer => o !== null);
  return { status: n.status, round: n.round, maxRounds: n.maxRounds, turn: n.turn, lastOffer: history.at(-1) ?? null, history, expiresAt: n.expiresAt };
};
export const loadState = async (id: string) => {
  const n = await prisma.agentNegotiation.findUniqueOrThrow({ where: { id } });
  const msgs = await prisma.agentMessage.findMany({ where: { negotiationId: id }, orderBy: { seq: "asc" } });
  return { n, msgs, state: stateOf(n, msgs), priv: privOf(n) };
};

async function names(ids: string[]): Promise<Map<string, string>> {
  try {
    const p = await identity.getTrustProfiles(ids);
    return new Map(ids.map((id) => [id, p.get(id)?.name ?? "Business"]));
  } catch {
    return new Map(ids.map((id) => [id, "Business"]));
  }
}

async function toView(n: AgentNegotiation, msgs: AgentMessage[], side: Side | "admin"): Promise<NegotiationView> {
  const nm = await names([n.buyerBusinessId, n.sellerBusinessId]);
  const me: Side = side === "admin" ? "buyer" : side;
  const state = stateOf(n, msgs);
  const conf = { buyer: n.buyerConfirmation as Confirmation, seller: n.sellerConfirmation as Confirmation };
  const agreed = n.agreedTerms ? (n.agreedTerms as unknown as OfferRecord) : null;
  const priv = privOf(n);
  return {
    id: n.id, status: n.status, youAre: me, admin: side === "admin",
    buyer: { businessId: n.buyerBusinessId, name: nm.get(n.buyerBusinessId)! }, seller: { businessId: n.sellerBusinessId, name: nm.get(n.sellerBusinessId)! },
    enquiryId: n.enquiryId, matchId: n.matchId, round: n.round, maxRounds: n.maxRounds, turn: n.turn,
    lastOffer: state.lastOffer ? { ...toOfferView(state.lastOffer), by: state.lastOffer.by } : null,
    agreed: agreed ? toOfferView(agreed) : null,
    yourConfirmation: conf[me], counterpartyConfirmed: isDone(conf[other(me)]), buyerConfirmed: isDone(conf.buyer), sellerConfirmed: isDone(conf.seller),
    canConfirm: side !== "admin" && n.status === "agreed" && conf[me] === "pending",
    yourLimits: side === "admin" ? null : ({ ...(side === "buyer" ? priv.buyer : priv.seller) } as unknown as Record<string, unknown>),
    external: n.buyerDriver === "external" || n.sellerDriver === "external", flagged: n.flagged,
    quoteId: n.quoteId, orderId: n.orderId, realiseError: n.realiseError, expiresAt: n.expiresAt.toISOString(), createdAt: n.createdAt.toISOString(), closedAt: n.closedAt?.toISOString() ?? null,
    messages: msgs.map((m) => {
      const o = offerOf(m);
      return { seq: m.seq, side: m.side, type: m.type, offer: o ? toOfferView(o) : null, actor: m.actorKind === "external_agent" ? "external_agent" : m.actorKind === "human" ? "person" : "agent", mine: side !== "admin" && m.side === me, createdAt: m.createdAt.toISOString() };
    }),
  };
}

function sideOf(n: { buyerBusinessId: string; sellerBusinessId: string }, businessId: string): Side | null {
  return n.buyerBusinessId === businessId ? "buyer" : n.sellerBusinessId === businessId ? "seller" : null;
}
async function requireOwn(actor: Actor, id: string): Promise<{ n: AgentNegotiation; side: Side }> {
  const n = isUuid(id) ? await prisma.agentNegotiation.findUnique({ where: { id } }) : null;
  const side = n ? sideOf(n, actor.businessId) : null;
  if (!n || !side) throw new DomainError("not_found", "Negotiation not found");
  return { n, side };
}

export async function getNegotiation(actor: Actor, id: string): Promise<NegotiationView | null> {
  try {
    const { n, side } = await requireOwn(actor, id);
    return toView(n, await prisma.agentMessage.findMany({ where: { negotiationId: n.id }, orderBy: { seq: "asc" } }), side);
  } catch (e) {
    if (e instanceof DomainError && e.code === "not_found") return null;
    throw e;
  }
}

export interface NegotiationSummary {
  id: string; status: AgentNegotiation["status"]; youAre: Side; counterparty: { businessId: string; name: string }; enquiryId: string; matchId: string;
  round: number; maxRounds: number; turn: Side | null; lastPricePaise: number | null; agreedPricePaise: number | null; canConfirm: boolean; external: boolean; flagged: boolean;
  createdAt: string; expiresAt: string;
}
export async function listNegotiations(businessId: string, opts: { side?: Side; status?: AgentNegotiation["status"]; needsConfirmation?: boolean; limit?: number } = {}): Promise<NegotiationSummary[]> {
  const where: Prisma.AgentNegotiationWhereInput = {
    ...(opts.side === "buyer" ? { buyerBusinessId: businessId } : opts.side === "seller" ? { sellerBusinessId: businessId } : { OR: [{ buyerBusinessId: businessId }, { sellerBusinessId: businessId }] }),
    ...(opts.status ? { status: opts.status } : {}),
  };
  const rows = await prisma.agentNegotiation.findMany({ where, orderBy: { createdAt: "desc" }, take: Math.min(opts.limit ?? 100, 200) });
  const nm = await names([...new Set(rows.flatMap((r) => [r.buyerBusinessId, r.sellerBusinessId]))]);
  const out = rows.map((r): NegotiationSummary => {
    const side = sideOf(r, businessId)!;
    const cp = other(side) === "buyer" ? r.buyerBusinessId : r.sellerBusinessId;
    const last = r.lastOffer as unknown as OfferRecord | null;
    const mine = (side === "buyer" ? r.buyerConfirmation : r.sellerConfirmation) as Confirmation;
    return {
      id: r.id, status: r.status, youAre: side, counterparty: { businessId: cp, name: nm.get(cp)! }, enquiryId: r.enquiryId, matchId: r.matchId, round: r.round, maxRounds: r.maxRounds,
      turn: r.turn, lastPricePaise: last?.pricePaise ?? null, agreedPricePaise: num(r.agreedPricePaise), canConfirm: r.status === "agreed" && mine === "pending", external: r.buyerDriver === "external" || r.sellerDriver === "external",
      flagged: r.flagged, createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString(),
    };
  });
  return opts.needsConfirmation ? out.filter((o) => o.canConfirm) : out;
}

// ---------------------------------------------------------------- start
const catCompatible = (a: string | null, b: string | null) => !a || !b || a === b;
const active = (m: AgentMandate, now: Date) => m.status === "active" && (!m.expiresAt || m.expiresAt.getTime() > now.getTime());

/** The counterparty's newest active, compatible mandate on the opposite side (null = they have no agent: fall back to the human quote flow). */
export async function findCounterpartyMandate(businessId: string, side: Side, categorySlug: string | null, now = new Date()): Promise<AgentMandate | null> {
  const rows = await prisma.agentMandate.findMany({ where: { businessId, side, status: "active" }, orderBy: { createdAt: "desc" }, take: 20 });
  return rows.find((m) => active(m, now) && catCompatible(m.categorySlug, categorySlug)) ?? null;
}

export interface StartInput { mandateId: string; matchId: string; /** idempotency key for the start (optional) */ startKey?: string | null }

/**
 * Opens a negotiation on a match between two businesses that both have an active mandate. The mandate must belong to the actor's
 * business and to the side the actor plays in that match. Idempotent per match: a second start returns the existing negotiation.
 */
export async function startNegotiation(actor: Actor, input: StartInput, via: Via = { kind: "human" }, opts: { now?: Date } = {}): Promise<NegotiationView> {
  requireEnabled();
  const now = opts.now ?? new Date();
  if (!isUuid(input.mandateId) || !isUuid(input.matchId)) throw new DomainError("not_found", "Mandate or match not found");
  const mine = await prisma.agentMandate.findFirst({ where: { id: input.mandateId, businessId: actor.businessId } });
  if (!mine) throw new DomainError("not_found", "Mandate not found");
  await assertNotSuspended({ businessId: actor.businessId, mandateIds: [mine.id], apiKeyId: via.apiKeyId });
  if (!active(mine, now)) throw new DomainError("conflict", `This mandate is ${mine.status === "active" ? "expired" : mine.status}.`);
  const match = await enquiry.getMatchSummary(input.matchId);
  if (!match) throw new DomainError("not_found", "Match not found");
  const role: Side | null = match.buyerBusinessId === actor.businessId ? "buyer" : match.sellerBusinessId === actor.businessId ? "seller" : null;
  if (!role) throw new DomainError("not_found", "Match not found");
  if (role !== mine.side) throw new DomainError("validation", `This is a ${mine.side} mandate but you are the ${role} in this match.`);
  if (!["offered", "accepted"].includes(match.status)) throw new DomainError("conflict", "This lead is no longer available.");

  const existing = await prisma.agentNegotiation.findUnique({ where: { matchId: match.id } });
  if (existing) return (await getNegotiation(actor, existing.id))!;
  await assertCanStart(actor.businessId);

  const cpBiz = role === "buyer" ? match.sellerBusinessId : match.buyerBusinessId;
  await assertNotSuspended({ businessId: cpBiz });
  const cp = await findCounterpartyMandate(cpBiz, other(role), mine.categorySlug, now);
  if (!cp) throw new DomainError("conflict", "The other business has no agent for this. Continue in the normal quote flow.");
  const buyerM = role === "buyer" ? mine : cp;
  const sellerM = role === "seller" ? mine : cp;
  await assertNotSuspended({ businessId: cpBiz, mandateIds: [cp.id] });
  const approved = (buyerM.approvedSellerIds ?? []) as string[];
  if (approved.length && !approved.includes(match.sellerBusinessId)) throw new DomainError("conflict", "That seller is not on the buyer mandate's approved list.");

  const enq = await enquiry.getEnquiryForOps(match.enquiryId);
  if (!enq) throw new DomainError("not_found", "Enquiry not found");
  const buyerSpec = (buyerM.spec ?? {}) as Record<string, string | null>;
  const sellerSpec = (sellerM.spec ?? {}) as Record<string, string | null>;
  const qty = buyerM.quantity ?? enq.quantity ?? 1;

  const book = sellerM.priceBookId
    ? await negotiation.getPriceBookEntry(sellerM.businessId, sellerM.priceBookId)
    : await negotiation.selectPriceBookForRfq(sellerM.businessId, { title: enq.title, requirement: enq.requirement, categorySlug: sellerM.categorySlug ?? buyerM.categorySlug });
  if (!book || !book.active) throw new DomainError("conflict", "The seller's agent has no price book entry for this requirement. Continue in the normal quote flow.");
  const unit = buyerM.unit ?? book.unit;
  if (unit.trim().toLowerCase() !== book.unit.trim().toLowerCase()) throw new DomainError("conflict", "The buyer and seller price in different units. Continue in the normal quote flow.");

  const tier = ai.tierPriceFor(book.basePricePaise, book.tiers, qty);
  const floor = Math.max(book.floorPricePaise, Number(sellerM.limitPricePaise ?? 0), sellerM.maxDiscountPct != null ? Math.ceil((tier * (100 - sellerM.maxDiscountPct)) / 100) : 0, 1);
  const buyerPrivate: BuyerPrivate = {
    maxPricePaise: Number(buyerM.limitPricePaise), targetPricePaise: num(buyerM.targetPricePaise), maxLeadTimeDays: buyerM.maxLeadTimeDays, quantity: buyerM.quantity, unit,
    deliveryTerms: buyerSpec.deliveryTerms ?? null, paymentTerms: buyerSpec.paymentTerms ?? null, autoAccept: buyerM.autoAccept, autoAcceptLimitPaise: num(buyerM.autoAcceptLimitPaise),
  };
  const sellerPrivate: SellerPrivate = {
    floorPricePaise: floor, basePricePaise: Math.max(tier, floor), minLeadTimeDays: book.leadTimeDays, leadTimeDays: book.leadTimeDays, moq: book.moq, capacityQty: sellerM.capacityQty,
    rfqQuantity: qty, unit: book.unit, deliveryTerms: sellerSpec.deliveryTerms ?? book.deliveryTerms, paymentTerms: sellerSpec.paymentTerms ?? null, validityDays: book.validityDays,
    autoAccept: sellerM.autoAccept, autoAcceptLimitPaise: num(sellerM.autoAcceptLimitPaise),
  };
  const external = via.kind === "external_agent";
  const expiresAt = new Date(now.getTime() + limits.negotiationTtlHours() * 3_600_000);
  let created: AgentNegotiation;
  try {
    created = await prisma.$transaction(async (tx) => {
      const n = await tx.agentNegotiation.create({
        data: {
          buyerBusinessId: match.buyerBusinessId, sellerBusinessId: match.sellerBusinessId, buyerMandateId: buyerM.id, sellerMandateId: sellerM.id, enquiryId: match.enquiryId, matchId: match.id,
          buyerDriver: role === "buyer" && external ? "external" : "internal", sellerDriver: role === "seller" && external ? "external" : "internal", initiatedBy: role, startKey: input.startKey ?? null,
          maxRounds: Math.min(buyerM.maxRounds, sellerM.maxRounds), turn: role, buyerPrivate: json(buyerPrivate), sellerPrivate: json(sellerPrivate), expiresAt,
        },
      });
      await emit(tx, "AgentNegotiationStarted", { type: "agent_negotiation", id: n.id }, { negotiationId: n.id, buyerBusinessId: n.buyerBusinessId, sellerBusinessId: n.sellerBusinessId, enquiryId: n.enquiryId, external });
      const who = external ? "An external agent acting for you" : "Your agent";
      await logActivity({ principalBusinessId: n.buyerBusinessId, principalSide: "buyer", action: "negotiation_started", mandateId: buyerM.id, negotiationId: n.id, summary: `${role === "buyer" ? who : "The seller's agent"} started negotiating "${enq.title}".` }, tx);
      await logActivity({ principalBusinessId: n.sellerBusinessId, principalSide: "seller", action: "negotiation_started", mandateId: sellerM.id, negotiationId: n.id, summary: `${role === "seller" ? who : "The buyer's agent"} started negotiating "${enq.title}".` }, tx);
      return n;
    });
  } catch (e) {
    const dup = await prisma.agentNegotiation.findUnique({ where: { matchId: match.id } });
    if (dup) return (await getNegotiation(actor, dup.id))!;
    throw e;
  }
  await scheduleAdvance(created.id, 0);
  return toView(created, [], role);
}

// ---------------------------------------------------------------- send
const violationError = (error: string, violations: string[]): DomainError => {
  const text: Record<string, string> = {
    closed: "This negotiation is closed.", expired: "This negotiation has expired.", not_your_turn: "It is not your turn.", no_standing_offer: "There is no offer to respond to yet.",
    opening_only: "Use `counter` to answer an offer; `offer` is only for the opening message.", own_offer: "You cannot respond to your own offer.", max_rounds: "The maximum number of rounds has been reached: accept, reject or withdraw.",
    out_of_bounds: violations[0] ?? "The terms are outside your mandate's bounds.", not_conceding: violations[0] ?? "Offers cannot move backwards.", offer_expired: violations[0] ?? "The offer has expired.", invalid_validity: violations[0] ?? "Invalid validity date.",
  };
  const code = ["out_of_bounds", "not_conceding", "invalid_validity", "opening_only", "no_standing_offer"].includes(error) ? "validation" : "conflict";
  return new DomainError(code, text[error] ?? "Not allowed.", { error, violations });
};

export interface SendOptions { idempotencyKey: string; via?: Via; now?: Date; personId?: string | null }

/**
 * Sends one protocol message as `actor`'s side. Enforces suspension, rate limits, anomaly guards, then the state machine and the
 * sender's own bounds. Returns the negotiation as this side sees it. Retrying with the same idempotencyKey is a no-op.
 */
export async function sendNegotiationMessage(actor: Actor, negotiationId: string, message: ProtocolMessageInput, o: SendOptions): Promise<NegotiationView> {
  requireEnabled();
  const via = o.via ?? { kind: "human" as const };
  const key = (o.idempotencyKey ?? "").trim();
  if (key.length < 1 || key.length > 100) throw new DomainError("validation", "An idempotency key of 1 to 100 characters is required.");
  const parsed = messageSchema.safeParse(message);
  if (!parsed.success) throw new DomainError("validation", parsed.error.issues[0]?.message ?? "Invalid message", parsed.error.issues);
  const msg = parsed.data;
  const { n: first, side } = await requireOwn(actor, negotiationId);

  const replay = await prisma.agentMessage.findUnique({ where: { negotiationId_side_idempotencyKey: { negotiationId, side, idempotencyKey: key } } });
  if (replay) return toView(first, await prisma.agentMessage.findMany({ where: { negotiationId }, orderBy: { seq: "asc" } }), side);

  await assertNotSuspended({ businessId: actor.businessId, mandateIds: [first.buyerMandateId, first.sellerMandateId].filter((_, i) => (i === 0) === (side === "buyer")), apiKeyId: via.apiKeyId });
  await assertNotSuspended({ businessId: side === "buyer" ? first.sellerBusinessId : first.buyerBusinessId });
  if (via.kind !== "internal_agent") await assertWithinRates(actor.businessId, via.apiKeyId);
  await guardBehaviour("message", { businessId: actor.businessId, side, negotiationId, apiKeyId: via.apiKeyId, fingerprint: fingerprint(side, msg) });

  const now = o.now ?? new Date();
  type Outcome = { kind: "ok"; agreed: boolean; open: boolean; round: number } | { kind: "expired" } | { kind: "err"; error: string; violations: string[] };
  const outcome = await prisma.$transaction(async (tx): Promise<Outcome> => {
    await tx.$queryRaw`SELECT id FROM agent_negotiation WHERE id = ${negotiationId}::uuid FOR UPDATE`;
    const n = await tx.agentNegotiation.findUniqueOrThrow({ where: { id: negotiationId } });
    const dup = await tx.agentMessage.findUnique({ where: { negotiationId_side_idempotencyKey: { negotiationId, side, idempotencyKey: key } } });
    if (dup) return { kind: "ok", agreed: n.status === "agreed", open: n.status === "open", round: n.round };
    const msgs = await tx.agentMessage.findMany({ where: { negotiationId }, orderBy: { seq: "asc" } });
    const r = step(stateOf(n, msgs), side, msg, privOf(n), now);
    if (!r.ok) {
      if (r.error === "expired") {
        await closeTx(tx, n, "expired", null, null, now);
        return { kind: "expired" };
      }
      return { kind: "err", error: r.error, violations: r.violations };
    }
    const seq = msgs.length + 1;
    const offer = msg.type === "offer" || msg.type === "counter" ? msg.offer : null;
    await tx.agentMessage.create({
      data: {
        negotiationId, seq, side, type: msg.type, pricePaise: offer ? BigInt(offer.pricePaise) : null, quantity: offer?.quantity ?? null,
        terms: offer ? json({ unit: offer.unit, leadTimeDays: offer.leadTimeDays, deliveryTerms: offer.deliveryTerms, validUntil: offer.validUntil, paymentTerms: offer.paymentTerms }) : undefined,
        idempotencyKey: key, actorKind: kindOfVia(via), apiKeyId: via.apiKeyId ?? null,
      },
    });
    const takeover = via.kind === "external_agent" ? (side === "buyer" ? { buyerDriver: "external" as const } : { sellerDriver: "external" as const }) : {};
    const mkActor = via.kind === "human" ? (o.personId ?? actor.personId) : null;
    const desc = (who: string) => (via.kind === "external_agent" ? `An external agent for ${who}` : via.kind === "human" ? "A person" : `The agent for ${who}`);
    const logBoth = async (action: "offer_sent" | "counter_sent" | "accepted" | "rejected" | "withdrawn", text: (mine: boolean) => string) => {
      for (const s of ["buyer", "seller"] as Side[]) {
        await logActivity({ principalBusinessId: s === "buyer" ? n.buyerBusinessId : n.sellerBusinessId, principalSide: s, action, negotiationId, summary: text(s === side), actorPersonId: s === side ? mkActor : null, details: offer ? { round: r.state.round, pricePaise: offer.pricePaise, quantity: offer.quantity } : {} }, tx);
      }
    };
    if (offer) {
      await tx.agentNegotiation.update({ where: { id: n.id }, data: { round: r.state.round, turn: r.state.turn, lastOffer: json(r.state.lastOffer), ...takeover } });
      await emit(tx, "AgentOfferMade", { type: "agent_negotiation", id: n.id }, { negotiationId: n.id, round: r.state.round, by: side, pricePaise: offer.pricePaise, quantity: offer.quantity });
      await logBoth(msg.type === "offer" ? "offer_sent" : "counter_sent", (mine) => `${mine ? desc("you") : "The other side's agent"} ${msg.type === "offer" ? "offered" : "countered with"} ${rupees(offer.pricePaise)} per ${offer.unit} for ${offer.quantity} ${offer.unit}, ${offer.leadTimeDays} days (round ${r.state.round}).`);
      return { kind: "ok", agreed: false, open: true, round: r.state.round };
    }
    if (r.closes === "agreed") {
      const terms = r.state.lastOffer!;
      const p = privOf(n);
      const bc: Confirmation = withinAutoAccept("buyer", terms, p) ? "auto" : "pending";
      const sc: Confirmation = withinAutoAccept("seller", terms, p) ? "auto" : "pending";
      await tx.agentNegotiation.update({
        where: { id: n.id },
        data: {
          status: "agreed", turn: null, agreedTerms: json(terms), agreedPricePaise: BigInt(terms.pricePaise), buyerConfirmation: bc, sellerConfirmation: sc,
          expiresAt: new Date(now.getTime() + limits.confirmTtlHours() * 3_600_000), ...takeover,
        },
      });
      await logBoth("accepted", (mine) => `${mine ? desc("you") : "The other side's agent"} accepted ${rupees(terms.pricePaise)} per ${terms.unit} for ${terms.quantity} ${terms.unit}. No deal exists until each business confirms.`);
      for (const s of ["buyer", "seller"] as Side[]) {
        const c = s === "buyer" ? bc : sc;
        await logActivity({
          principalBusinessId: s === "buyer" ? n.buyerBusinessId : n.sellerBusinessId, principalSide: s, action: c === "auto" ? "confirmed_auto" : "awaiting_confirmation", negotiationId,
          summary: c === "auto" ? "Auto-accept applied: the terms are inside the limits you allowed, so your side is confirmed." : "Waiting for your confirmation. Nothing is committed until you confirm.",
        }, tx);
      }
      return { kind: "ok", agreed: true, open: false, round: r.state.round };
    }
    if (r.closes === "rejected" || r.closes === "withdrawn") {
      await closeTx(tx, n, r.closes, null, null, now);
      await logBoth(r.closes === "rejected" ? "rejected" : "withdrawn", (mine) => (r.closes === "rejected" ? `${mine ? desc("you") : "The other side's agent"} rejected the offer. The negotiation is closed.` : `${mine ? desc("you") : "The other side"} withdrew. The negotiation is closed.`));
    }
    return { kind: "ok", agreed: false, open: false, round: r.state.round };
  });

  if (outcome.kind === "expired") throw violationError("expired", []);
  if (outcome.kind === "err") {
    if (["out_of_bounds", "not_conceding"].includes(outcome.error)) await guardBehaviour("out_of_bounds", { businessId: actor.businessId, side, negotiationId, apiKeyId: via.apiKeyId });
    throw violationError(outcome.error, outcome.violations);
  }
  const fresh = await prisma.agentNegotiation.findUniqueOrThrow({ where: { id: negotiationId } });
  if (fresh.status === "open" && fresh.turn && (fresh.turn === "buyer" ? fresh.buyerDriver : fresh.sellerDriver) === "internal") await scheduleAdvance(negotiationId, fresh.round);
  if (fresh.status === "agreed" && isDone(fresh.buyerConfirmation as Confirmation) && isDone(fresh.sellerConfirmation as Confirmation)) await finalise(negotiationId).catch(() => scheduleFinalise(negotiationId));
  const after = await prisma.agentNegotiation.findUniqueOrThrow({ where: { id: negotiationId } });
  return toView(after, await prisma.agentMessage.findMany({ where: { negotiationId }, orderBy: { seq: "asc" } }), side);
}

async function closeTx(tx: Tx, n: AgentNegotiation, outcome: "rejected" | "withdrawn" | "expired", confirmedBy: "human" | "auto" | null, pricePaise: number | null, now: Date): Promise<void> {
  const { count } = await tx.agentNegotiation.updateMany({ where: { id: n.id, status: { in: ["open", "agreed"] } }, data: { status: outcome, turn: null, closedAt: now } });
  if (count === 0) return;
  await emit(tx, "AgentNegotiationClosed", { type: "agent_negotiation", id: n.id }, { negotiationId: n.id, outcome, confirmedBy, pricePaise });
  if (outcome === "expired") {
    for (const s of ["buyer", "seller"] as Side[]) {
      await logActivity({ principalBusinessId: s === "buyer" ? n.buyerBusinessId : n.sellerBusinessId, principalSide: s, action: "expired", negotiationId: n.id, summary: "The negotiation expired without a confirmed deal." }, tx);
    }
  }
}

// ---------------------------------------------------------------- human confirmation
/**
 * The principal's decision on an agreed negotiation. Confirm commits this side; when both sides are confirmed (by a person, or by
 * auto-accept within bounds) the Quote and Order are created. Decline closes the negotiation as rejected.
 */
export async function confirmNegotiation(actor: Actor, negotiationId: string, decision: "confirm" | "decline", o: { now?: Date } = {}): Promise<NegotiationView> {
  const { n: first, side } = await requireOwn(actor, negotiationId);
  await assertNotSuspended({ businessId: actor.businessId });
  const now = o.now ?? new Date();
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM agent_negotiation WHERE id = ${negotiationId}::uuid FOR UPDATE`;
    const n = await tx.agentNegotiation.findUniqueOrThrow({ where: { id: negotiationId } });
    if (n.status !== "agreed") throw new DomainError("conflict", n.status === "accepted" ? "This deal is already confirmed." : "There is nothing to confirm on this negotiation.");
    if (now.getTime() > n.expiresAt.getTime()) {
      await closeTx(tx, n, "expired", null, null, now);
      return "expired" as const;
    }
    const mineNow = (side === "buyer" ? n.buyerConfirmation : n.sellerConfirmation) as Confirmation;
    if (mineNow !== "pending") return "noop" as const;
    if (decision === "decline") {
      await tx.agentNegotiation.update({ where: { id: n.id }, data: side === "buyer" ? { buyerConfirmation: "declined" } : { sellerConfirmation: "declined" } });
      await closeTx(tx, n, "rejected", null, null, now);
      for (const s of ["buyer", "seller"] as Side[]) {
        await logActivity({ principalBusinessId: s === "buyer" ? n.buyerBusinessId : n.sellerBusinessId, principalSide: s, action: "declined", negotiationId: n.id, summary: s === side ? "You declined the agreed terms. No deal was made." : "The other business declined the agreed terms. No deal was made.", actorPersonId: s === side ? actor.personId : null }, tx);
      }
      return "declined" as const;
    }
    await tx.agentNegotiation.update({ where: { id: n.id }, data: side === "buyer" ? { buyerConfirmation: "human" } : { sellerConfirmation: "human" } });
    await logActivity({ principalBusinessId: actor.businessId, principalSide: side, action: "confirmed", negotiationId: n.id, summary: "You confirmed the agreed terms.", actorPersonId: actor.personId }, tx);
    return "confirmed" as const;
  });
  if (result === "expired") throw new DomainError("conflict", "The confirmation window has passed. The negotiation expired.");
  if (result === "confirmed") {
    const fresh = await prisma.agentNegotiation.findUniqueOrThrow({ where: { id: negotiationId } });
    if (isDone(fresh.buyerConfirmation as Confirmation) && isDone(fresh.sellerConfirmation as Confirmation)) await finalise(negotiationId).catch(() => scheduleFinalise(negotiationId));
  }
  void first;
  return (await getNegotiation(actor, negotiationId))!;
}

/** A person withdraws: while open it is a protocol `withdraw`; once agreed it is a decline. */
export async function withdrawNegotiation(actor: Actor, negotiationId: string): Promise<NegotiationView> {
  const { n } = await requireOwn(actor, negotiationId);
  if (n.status === "agreed") return confirmNegotiation(actor, negotiationId, "decline");
  return sendNegotiationMessage(actor, negotiationId, { type: "withdraw" }, { idempotencyKey: `human-withdraw-${actor.personId}`, via: { kind: "human" }, personId: actor.personId });
}

// ---------------------------------------------------------------- realisation: Quote + Order through enquiry's public functions
/** The agreed offer as structured quote terms (ADR-020 typed terms -> enquiry.Quote fields). The free-text protocol terms are kept as notes. */
function quoteTermsFor(t: OfferRecord) {
  const d = negotiation.mapShippingTerms(t.deliveryTerms);
  const p = negotiation.mapPaymentTerms(t.paymentTerms);
  return { deliveryTerms: d.deliveryTerms, deliveryNote: d.deliveryNote, paymentTerms: p.paymentTerms, paymentNote: p.paymentNote };
}

/**
 * Resumability without a notes marker: a crash between sendQuote and saving `quoteId` must not double-quote. Looks for the seller's own
 * quote for this match that already carries the agreed terms (sent since the negotiation began), and for legacy quotes the
 * `[a2a:<id>]` marker written before structured terms existed.
 */
async function findExistingQuote(seller: Actor, n: AgentNegotiation, conversationId: string, t: OfferRecord): Promise<string | null> {
  const { items } = await enquiry.listSellerQuotes(seller, { limit: 50 });
  const hit = items.find((q) => q.matchId === n.matchId && q.pricePaise === t.pricePaise && q.quantity === t.quantity && q.unit === t.unit && q.createdAt >= n.createdAt.toISOString());
  if (hit) return hit.id;
  const legacy = (await enquiry.getConversation(seller, conversationId))?.quotes.find((q) => q.notes?.includes(`[a2a:${n.id}]`));
  return legacy?.id ?? null;
}

/**
 * Both sides confirmed -> accept the lead if still offered (the seller's confirmation is the explicit decision to spend the credit),
 * send the agreed Quote as the seller, record the Order, close the negotiation as accepted. Idempotent and resumable: the quote is
 * recognised by matching the seller's quote for this match (older quotes carry an `[a2a:<id>]` notes marker, still honoured), the order is one-per-match. A failure leaves the negotiation `agreed` with `realiseError`
 * so a person can retry; nothing is ever half-recorded as accepted.
 */
export async function finalise(negotiationId: string): Promise<NegotiationView | null> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"a2a:finalise:" + negotiationId}))`;
    const n = await tx.agentNegotiation.findUniqueOrThrow({ where: { id: negotiationId } });
    if (n.status !== "agreed" || !isDone(n.buyerConfirmation as Confirmation) || !isDone(n.sellerConfirmation as Confirmation)) return { done: false as const };
    const terms = n.agreedTerms as unknown as OfferRecord;
    const sellerM = await tx.agentMandate.findUniqueOrThrow({ where: { id: n.sellerMandateId } });
    const buyerM = await tx.agentMandate.findUniqueOrThrow({ where: { id: n.buyerMandateId } });
    const seller = { personId: sellerM.createdByPersonId, businessId: n.sellerBusinessId };
    const buyer = { personId: buyerM.createdByPersonId, businessId: n.buyerBusinessId };
    try {
      let lead = await enquiry.getSellerLead(n.sellerBusinessId, n.matchId);
      if (!lead) throw new DomainError("not_found", "The lead is gone.");
      if (lead.status === "offered") lead = await enquiry.acceptLead(seller, n.matchId);
      if (lead.status !== "accepted" || !lead.conversationId) throw new DomainError("conflict", "The lead is no longer available, so the deal cannot be recorded.");
      let quoteId = n.quoteId;
      if (quoteId && !(await enquiry.getQuote(seller, quoteId))) quoteId = null; // stale pointer: recover or resend below
      if (!quoteId) {
        quoteId = await findExistingQuote(seller, n, lead.conversationId, terms);
        if (!quoteId) {
          quoteId = (await enquiry.sendQuote(seller, lead.conversationId, {
            pricePaise: terms.pricePaise, quantity: terms.quantity, unit: terms.unit, leadTimeDays: terms.leadTimeDays, validUntil: terms.validUntil,
            notes: "Agreed through agent negotiation.", ...quoteTermsFor(terms),
          })).quoteId;
        }
        await prisma.agentNegotiation.update({ where: { id: n.id }, data: { quoteId } });
      }
      const order = await enquiry.recordOrderFromDeal(buyer, n.matchId, { quoteId, quantity: terms.quantity, unit: terms.unit, pricePaise: terms.pricePaise });
      for (const a of [buyer, seller]) await enquiry.confirmOrder(a, order.id).catch(() => undefined);
      const both = n.buyerConfirmation === "auto" && n.sellerConfirmation === "auto";
      const now = new Date();
      await tx.agentNegotiation.update({ where: { id: n.id }, data: { status: "accepted", quoteId, orderId: order.id, realiseError: null, closedAt: now, turn: null } });
      await emit(tx, "AgentNegotiationClosed", { type: "agent_negotiation", id: n.id }, { negotiationId: n.id, outcome: "accepted", confirmedBy: both ? "auto" : "human", pricePaise: terms.pricePaise });
      for (const s of ["buyer", "seller"] as Side[]) {
        await logActivity({ principalBusinessId: s === "buyer" ? n.buyerBusinessId : n.sellerBusinessId, principalSide: s, action: "order_recorded", negotiationId: n.id, summary: `Deal confirmed at ${rupees(terms.pricePaise)} per ${terms.unit} for ${terms.quantity} ${terms.unit}. The quote and order are recorded.`, details: { quoteId, orderId: order.id } }, tx);
      }
      return { done: true as const };
    } catch (e) {
      const message = e instanceof DomainError ? e.message : "Could not record the deal. It will be retried.";
      const terminal = e instanceof DomainError && e.code === "conflict";
      await prisma.agentNegotiation.update({ where: { id: n.id }, data: { realiseError: message.slice(0, 300) } });
      await logActivity({ principalBusinessId: n.sellerBusinessId, principalSide: "seller", action: "realise_failed", negotiationId: n.id, summary: `The deal could not be recorded: ${message}` }, tx);
      await logActivity({ principalBusinessId: n.buyerBusinessId, principalSide: "buyer", action: "realise_failed", negotiationId: n.id, summary: `The deal could not be recorded: ${message}` }, tx);
      if (terminal) {
        await closeTx(tx, n, "expired", null, null, new Date());
        return { done: false as const };
      }
      if (!(e instanceof DomainError)) throw e;
      return { done: false as const };
    }
  }, { timeout: 30_000, maxWait: 10_000 });
  void outcome;
  const n = await prisma.agentNegotiation.findUnique({ where: { id: negotiationId } });
  return n ? toView(n, await prisma.agentMessage.findMany({ where: { negotiationId }, orderBy: { seq: "asc" } }), "buyer") : null;
}

/** Retry recording an agreed, fully confirmed deal that failed (for example the seller had no credits). Either principal may trigger it. */
export async function retryRealisation(actor: Actor, negotiationId: string): Promise<NegotiationView> {
  await requireOwn(actor, negotiationId);
  await finalise(negotiationId);
  return (await getNegotiation(actor, negotiationId))!;
}

// ---------------------------------------------------------------- withdraw / expire (system)
/** Withdraws open/agreed negotiations of a mandate or business (revoke, pause, expiry, suspension). Returns how many. */
export async function withdrawOpenNegotiations(scope: { mandateId?: string; businessId?: string }, reason: string, by: { personId: string | null; via?: Via }): Promise<number> {
  const or: Prisma.AgentNegotiationWhereInput[] = [];
  if (scope.mandateId) or.push({ buyerMandateId: scope.mandateId }, { sellerMandateId: scope.mandateId });
  if (scope.businessId) or.push({ buyerBusinessId: scope.businessId }, { sellerBusinessId: scope.businessId });
  if (or.length === 0) return 0;
  const rows = await prisma.agentNegotiation.findMany({ where: { status: { in: ["open", "agreed"] }, OR: or }, take: 500 });
  let n = 0;
  const now = new Date();
  for (const r of rows) {
    await prisma.$transaction(async (tx) => {
      const before = await tx.agentNegotiation.findUniqueOrThrow({ where: { id: r.id } });
      if (!["open", "agreed"].includes(before.status)) return;
      await closeTx(tx, before, "withdrawn", null, null, now);
      for (const s of ["buyer", "seller"] as Side[]) {
        await logActivity({ principalBusinessId: s === "buyer" ? r.buyerBusinessId : r.sellerBusinessId, principalSide: s, action: "withdrawn", negotiationId: r.id, summary: `The negotiation was withdrawn: ${reason}`, actorPersonId: by.personId }, tx);
      }
      n++;
    });
  }
  return n;
}

/** Job: negotiations past their expiry (open, or agreed but unconfirmed) close as expired. Returns how many. */
export async function expireNegotiations(now = new Date()): Promise<number> {
  const due = await prisma.agentNegotiation.findMany({ where: { status: { in: ["open", "agreed"] }, expiresAt: { lt: now } }, take: 200 });
  let n = 0;
  for (const d of due) {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM agent_negotiation WHERE id = ${d.id}::uuid FOR UPDATE`;
      const cur = await tx.agentNegotiation.findUniqueOrThrow({ where: { id: d.id } });
      if (!["open", "agreed"].includes(cur.status) || cur.expiresAt.getTime() >= now.getTime()) return;
      await closeTx(tx, cur, "expired", null, null, now);
      n++;
    });
  }
  return n;
}

// ---------------------------------------------------------------- admin reads (no private bounds)
export async function adminGetNegotiation(id: string): Promise<NegotiationView | null> {
  const n = isUuid(id) ? await prisma.agentNegotiation.findUnique({ where: { id } }) : null;
  if (!n) return null;
  return toView(n, await prisma.agentMessage.findMany({ where: { negotiationId: n.id }, orderBy: { seq: "asc" } }), "admin");
}
export async function adminListNegotiations(opts: { status?: AgentNegotiation["status"]; flagged?: boolean; businessId?: string; limit?: number } = {}) {
  const rows = await prisma.agentNegotiation.findMany({
    where: { ...(opts.status ? { status: opts.status } : {}), ...(opts.flagged ? { flagged: true } : {}), ...(opts.businessId ? { OR: [{ buyerBusinessId: opts.businessId }, { sellerBusinessId: opts.businessId }] } : {}) },
    orderBy: { createdAt: "desc" }, take: Math.min(opts.limit ?? 100, 300),
  });
  const nm = await names([...new Set(rows.flatMap((r) => [r.buyerBusinessId, r.sellerBusinessId]))]);
  return rows.map((r) => ({
    id: r.id, status: r.status, buyer: { businessId: r.buyerBusinessId, name: nm.get(r.buyerBusinessId)! }, seller: { businessId: r.sellerBusinessId, name: nm.get(r.sellerBusinessId)! }, round: r.round, maxRounds: r.maxRounds,
    agreedPricePaise: num(r.agreedPricePaise), external: r.buyerDriver === "external" || r.sellerDriver === "external", flagged: r.flagged, buyerMandateId: r.buyerMandateId, sellerMandateId: r.sellerMandateId,
    createdAt: r.createdAt.toISOString(), closedAt: r.closedAt?.toISOString() ?? null,
  }));
}
export async function adminListMandates(opts: { side?: Side; status?: AgentMandate["status"]; businessId?: string; limit?: number } = {}) {
  const rows = await prisma.agentMandate.findMany({
    where: { ...(opts.side ? { side: opts.side } : {}), ...(opts.status ? { status: opts.status } : {}), ...(opts.businessId ? { businessId: opts.businessId } : {}) }, orderBy: { createdAt: "desc" }, take: Math.min(opts.limit ?? 100, 300),
  });
  const nm = await names([...new Set(rows.map((r) => r.businessId))]);
  // limits are deliberately not returned: staff review behaviour, not a business's floor or ceiling
  return rows.map((m) => ({
    id: m.id, businessId: m.businessId, businessName: nm.get(m.businessId)!, side: m.side, status: m.status, name: m.name, categorySlug: m.categorySlug, autoAccept: m.autoAccept,
    recurrenceDays: m.recurrenceDays, expiresAt: m.expiresAt?.toISOString() ?? null, createdAt: m.createdAt.toISOString(),
  }));
}
void big;
