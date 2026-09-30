// Orders (ADR-007): the Enquiry -> Match -> Conversation -> Quote -> Order lifecycle is modelled now;
// Phase-1 orders are OFF-PLATFORM records (no money moves) created from a "won" deal report or an
// accepted quote. Phase-2 escrow (ADR-012) attaches to these rows.
import { DomainError, emit } from "@cnote/core";
import { prisma, type Order, type OrderStatus, type Tx } from "@cnote/db";
import { profiles } from "./support";
import type { Actor } from "./types";

export type OrderRole = "buyer" | "seller";

// ---------------------------------------------------------------------------------------------
// State machine (pure; the DB functions below only load, apply and persist).
// recorded -> confirmed -> dispatched -> delivered -> completed; cancel from recorded/confirmed only.
// ---------------------------------------------------------------------------------------------

/** Statuses reachable by an explicit move (`confirmed` is only reached by both parties confirming). */
export type OrderMove = "dispatched" | "delivered" | "completed" | "cancelled";

export interface OrderState {
  status: OrderStatus;
  buyerConfirmedAt: Date | null;
  sellerConfirmedAt: Date | null;
}

/** Which role may perform each move, and from which statuses. */
export const ORDER_MOVES: Record<OrderMove, { from: OrderStatus[]; roles: OrderRole[] }> = {
  dispatched: { from: ["confirmed"], roles: ["seller"] },
  delivered: { from: ["dispatched"], roles: ["buyer"] },
  completed: { from: ["delivered"], roles: ["buyer"] },
  cancelled: { from: ["recorded", "confirmed"], roles: ["buyer", "seller"] },
};

export const TERMINAL_ORDER_STATUSES: OrderStatus[] = ["completed", "cancelled"];

/** Applies one party's confirmation. Idempotent for a party that already confirmed. Both confirmed => `confirmed`. */
export function applyConfirm(s: OrderState, role: OrderRole, now: Date): OrderState {
  if (s.status !== "recorded") {
    const already = role === "buyer" ? s.buyerConfirmedAt : s.sellerConfirmedAt;
    if (already && s.status !== "cancelled") return s; // idempotent re-confirm of an order that moved on
    throw new DomainError("conflict", `This order is ${s.status} and can no longer be confirmed.`);
  }
  const next = { ...s };
  if (role === "buyer") next.buyerConfirmedAt ??= now;
  else next.sellerConfirmedAt ??= now;
  if (next.buyerConfirmedAt && next.sellerConfirmedAt) next.status = "confirmed";
  return next;
}

/** Applies an explicit move, enforcing role and source status. Throws DomainError otherwise. */
export function applyMove(s: OrderState, role: OrderRole, to: OrderMove): OrderState {
  const rule = ORDER_MOVES[to] as { from: OrderStatus[]; roles: OrderRole[] } | undefined;
  if (!rule) throw new DomainError("validation", "Unknown order status.");
  if (!rule.roles.includes(role)) {
    throw new DomainError("forbidden", `Only the ${rule.roles.join(" or ")} can mark an order ${to}.`);
  }
  if (!rule.from.includes(s.status)) throw new DomainError("conflict", `An order that is ${s.status} cannot be marked ${to}.`);
  return { ...s, status: to };
}

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------

export interface OrderView {
  id: string;
  matchId: string;
  enquiryId: string;
  enquiryTitle: string;
  quoteId: string | null;
  role: OrderRole;
  status: OrderStatus;
  settlement: string;
  counterparty: { businessId: string; name: string };
  pricePaise: number | null;
  quantity: number | null;
  unit: string | null;
  totalPaise: number | null;
  currency: string;
  buyerConfirmedAt: string | null;
  sellerConfirmedAt: string | null;
  /** What this actor can do next (drives the UI; the functions re-check on every call). */
  actions: { confirm: boolean; moves: OrderMove[] };
  createdAt: string;
  updatedAt: string;
}

export interface OrderPage {
  items: OrderView[];
  nextCursor: string | null;
}

const UUID = /^[0-9a-f-]{36}$/i;
const PAGE = 20;

function roleOf(o: Pick<Order, "buyerBusinessId" | "sellerBusinessId">, actor: Actor): OrderRole | null {
  if (o.buyerBusinessId === actor.businessId) return "buyer";
  if (o.sellerBusinessId === actor.businessId) return "seller";
  return null;
}

export function availableActions(o: OrderState, role: OrderRole): OrderView["actions"] {
  const myConfirm = role === "buyer" ? o.buyerConfirmedAt : o.sellerConfirmedAt;
  const moves = (Object.keys(ORDER_MOVES) as OrderMove[]).filter((m) => ORDER_MOVES[m].roles.includes(role) && ORDER_MOVES[m].from.includes(o.status));
  return { confirm: o.status === "recorded" && !myConfirm, moves };
}

async function toViews(rows: Order[], actor: Actor): Promise<OrderView[]> {
  if (rows.length === 0) return [];
  const [enquiries, profs] = await Promise.all([
    prisma.enquiry.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.enquiryId))] } }, select: { id: true, title: true } }),
    profiles(rows.flatMap((r) => [r.buyerBusinessId, r.sellerBusinessId])),
  ]);
  const titles = new Map(enquiries.map((e) => [e.id, e.title]));
  return rows.map((o) => {
    const role = roleOf(o, actor) as OrderRole;
    const other = role === "buyer" ? o.sellerBusinessId : o.buyerBusinessId;
    return {
      id: o.id,
      matchId: o.matchId,
      enquiryId: o.enquiryId,
      enquiryTitle: titles.get(o.enquiryId) ?? "Requirement",
      quoteId: o.quoteId,
      role,
      status: o.status,
      settlement: o.settlement,
      counterparty: { businessId: other, name: profs.get(other)?.name ?? (role === "buyer" ? "Seller" : "Buyer") },
      pricePaise: o.pricePaise === null ? null : Number(o.pricePaise),
      quantity: o.quantity,
      unit: o.unit,
      totalPaise: o.totalPaise === null ? null : Number(o.totalPaise),
      currency: o.currency,
      buyerConfirmedAt: o.buyerConfirmedAt?.toISOString() ?? null,
      sellerConfirmedAt: o.sellerConfirmedAt?.toISOString() ?? null,
      actions: availableActions(o, role),
      createdAt: o.createdAt.toISOString(),
      updatedAt: o.updatedAt.toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------

export interface RecordOrderInput {
  quoteId?: string | null;
  quantity?: number | null;
  unit?: string | null;
  /** Per-unit price in paise. */
  pricePaise?: number | null;
  /** Explicit total (e.g. the value reported with a "won" deal); computed from price x quantity otherwise. */
  totalPaise?: number | null;
}

/** Bigint-safe total: per-unit paise x whole units. */
export function computeTotalPaise(pricePaise: bigint | null, quantity: number | null): bigint | null {
  if (pricePaise === null || quantity === null) return null;
  return pricePaise * BigInt(quantity);
}

function checkInput(i: RecordOrderInput): void {
  const bad = (v: number | null | undefined, min: number) => v != null && (!Number.isInteger(v) || v < min);
  if (bad(i.quantity, 1)) throw new DomainError("validation", "Quantity must be a whole number above 0.");
  if (bad(i.pricePaise, 0) || bad(i.totalPaise, 0)) throw new DomainError("validation", "Amounts must be whole paise, 0 or more.");
  if (i.unit != null && (i.unit.trim() === "" || i.unit.length > 32)) throw new DomainError("validation", "Invalid unit.");
}

/**
 * Records the order for an accepted match, inside the caller's transaction. Idempotent per matchId
 * (one order per match): a second call returns the existing row and emits nothing. Callers must have
 * verified that the actor participates in the match.
 */
export async function recordOrderTx(tx: Tx, matchId: string, input: RecordOrderInput = {}): Promise<{ order: Order; created: boolean }> {
  checkInput(input);
  await tx.$queryRaw`SELECT id FROM matches WHERE id = ${matchId}::uuid FOR UPDATE`;
  const existing = await tx.order.findUnique({ where: { matchId } });
  if (existing) return { order: existing, created: false };

  const match = await tx.match.findUnique({ where: { id: matchId }, include: { enquiry: { select: { id: true, buyerBusinessId: true } }, conversation: { select: { id: true } } } });
  if (!match) throw new DomainError("not_found", "Conversation not found");
  if (match.status !== "accepted") throw new DomainError("conflict", "Only accepted leads can become orders.");

  let quote = null;
  if (input.quoteId) {
    if (!UUID.test(input.quoteId)) throw new DomainError("not_found", "Quote not found");
    quote = await tx.quote.findUnique({ where: { id: input.quoteId } });
    if (!quote || quote.conversationId !== match.conversation?.id) throw new DomainError("not_found", "Quote not found");
  } else if (match.conversation) {
    quote = await tx.quote.findFirst({ where: { conversationId: match.conversation.id }, orderBy: { createdAt: "desc" } });
  }

  const quantity = input.quantity ?? quote?.quantity ?? null;
  const unit = input.unit ?? quote?.unit ?? null;
  const pricePaise = input.pricePaise != null ? BigInt(input.pricePaise) : (quote?.pricePaise ?? null);
  const totalPaise = input.totalPaise != null ? BigInt(input.totalPaise) : computeTotalPaise(pricePaise, quantity);

  const order = await tx.order.create({
    data: {
      matchId,
      enquiryId: match.enquiryId,
      quoteId: quote?.id ?? null,
      buyerBusinessId: match.enquiry.buyerBusinessId,
      sellerBusinessId: match.sellerBusinessId,
      pricePaise,
      quantity,
      unit,
      totalPaise,
    },
  });
  await emit(tx, "OrderRecorded", { type: "order", id: order.id }, {
    orderId: order.id,
    matchId,
    enquiryId: match.enquiryId,
    buyerBusinessId: order.buyerBusinessId,
    sellerBusinessId: order.sellerBusinessId,
    totalPaise: totalPaise === null ? null : Number(totalPaise),
  });
  return { order, created: true };
}

/** Records the order for a match the actor participates in (explicitly, from an accepted quote, or after a "won" report). */
export async function recordOrderFromDeal(actor: Actor, matchId: string, input: RecordOrderInput = {}): Promise<OrderView> {
  if (!UUID.test(matchId)) throw new DomainError("not_found", "Conversation not found");
  const m = await prisma.match.findUnique({ where: { id: matchId }, include: { enquiry: { select: { buyerBusinessId: true } } } });
  const participant = m && (m.sellerBusinessId === actor.businessId || m.enquiry.buyerBusinessId === actor.businessId);
  if (!m || !participant) throw new DomainError("not_found", "Conversation not found");
  const { order } = await prisma.$transaction((tx) => recordOrderTx(tx, matchId, input));
  return (await toViews([order], actor))[0]!;
}

// ---------------------------------------------------------------------------------------------
// Confirmation and transitions
// ---------------------------------------------------------------------------------------------

async function loadLocked(tx: Tx, actor: Actor, orderId: string): Promise<{ order: Order; role: OrderRole }> {
  if (!UUID.test(orderId)) throw new DomainError("not_found", "Order not found");
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  const order = await tx.order.findUnique({ where: { id: orderId } });
  const role = order ? roleOf(order, actor) : null;
  if (!order || !role) throw new DomainError("not_found", "Order not found"); // non-participants: indistinguishable from missing
  return { order, role };
}

async function persist(tx: Tx, order: Order, next: OrderState): Promise<Order> {
  const updated = await tx.order.update({
    where: { id: order.id },
    data: { status: next.status, buyerConfirmedAt: next.buyerConfirmedAt, sellerConfirmedAt: next.sellerConfirmedAt },
  });
  if (updated.status !== order.status) {
    await emit(tx, "OrderStatusChanged", { type: "order", id: order.id }, {
      orderId: order.id, buyerBusinessId: order.buyerBusinessId, sellerBusinessId: order.sellerBusinessId, from: order.status, to: updated.status,
    });
  }
  return updated;
}

/** Records the actor's side of the two-party confirmation; both sides confirmed => status `confirmed`. */
export async function confirmOrder(actor: Actor, orderId: string): Promise<OrderView> {
  const updated = await prisma.$transaction(async (tx) => {
    const { order, role } = await loadLocked(tx, actor, orderId);
    const next = applyConfirm(order, role, new Date());
    return next === order ? order : persist(tx, order, next);
  });
  return (await toViews([updated], actor))[0]!;
}

/** Moves the order along its lifecycle (dispatched: seller; delivered/completed: buyer; cancelled: either, before dispatch). */
export async function transitionOrder(actor: Actor, orderId: string, to: OrderMove): Promise<OrderView> {
  const updated = await prisma.$transaction(async (tx) => {
    const { order, role } = await loadLocked(tx, actor, orderId);
    return persist(tx, order, applyMove(order, role, to));
  });
  return (await toViews([updated], actor))[0]!;
}

// ---------------------------------------------------------------------------------------------
// Reads (participants only)
// ---------------------------------------------------------------------------------------------

export async function getOrder(actor: Actor, id: string): Promise<OrderView | null> {
  if (!UUID.test(id)) return null;
  const o = await prisma.order.findUnique({ where: { id } });
  if (!o || !roleOf(o, actor)) return null;
  return (await toViews([o], actor))[0]!;
}

export async function listOrders(actor: Actor, opts: { role: OrderRole; cursor?: string | null }): Promise<OrderPage> {
  const where = opts.role === "buyer" ? { buyerBusinessId: actor.businessId } : { sellerBusinessId: actor.businessId };
  const cursor = opts.cursor && UUID.test(opts.cursor) ? { id: opts.cursor } : undefined;
  const rows = await prisma.order.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAGE + 1,
    ...(cursor ? { cursor, skip: 1 } : {}),
  });
  const page = rows.slice(0, PAGE);
  return { items: await toViews(page, actor), nextCursor: rows.length > PAGE ? page[page.length - 1]!.id : null };
}
