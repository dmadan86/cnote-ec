// ONDC orders (ADR-017): stored from /confirm in our own table (full Beckn payload, idempotent), mirrored to the
// enquiry Order model through the order-sink port when wired. Seller accept/reject drives on_status / on_cancel.
import { DomainError, emit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { newMessageId, type BecknContext } from "./beckn";
import { loadConfig, type OndcConfig } from "./config";
import { paiseToDecimal } from "./mapping";
import { queueCallback } from "./outbound";
import type { QuoteLine } from "./quote";
import { getOrderSink, mirrorDecision } from "./sink";

export type OndcOrderStatus = "created" | "accepted" | "in_progress" | "completed" | "cancelled";
export const BECKN_STATE: Record<OndcOrderStatus, string> = {
  created: "Created", accepted: "Accepted", in_progress: "In-progress", completed: "Completed", cancelled: "Cancelled",
};
const UUID = /^[0-9a-f-]{36}$/i;
const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

interface OrderRow {
  id: string; status: string; totalPaise: bigint; currency: string; items: unknown; payload: unknown; sellerBusinessId: string; cancelReason: string | null;
  createdAt: Date; updatedAt: Date; fulfilmentState?: string | null;
}

/** Sets `state.descriptor.code` on each fulfilment (F1 when the confirm carried none). */
function withFulfilmentState(f: unknown, code: string): unknown[] {
  const list = Array.isArray(f) && f.length ? (f as Record<string, unknown>[]) : [{ id: "F1", type: "Delivery" }];
  return list.map((x) => ({ ...x, state: { descriptor: { code } } }));
}

/** The Beckn `order` object we return in on_confirm / on_status / on_cancel. */
export function orderToBeckn(o: OrderRow): Record<string, unknown> {
  const p = (o.payload ?? {}) as { message?: { order?: Record<string, unknown> } };
  const src = p.message?.order ?? {};
  return {
    id: o.id,
    state: BECKN_STATE[o.status as OndcOrderStatus] ?? o.status,
    provider: { id: o.sellerBusinessId },
    items: src.items ?? [],
    billing: src.billing,
    fulfillments: o.fulfilmentState ? withFulfilmentState(src.fulfillments, o.fulfilmentState) : src.fulfillments,
    payment: src.payment,
    quote: { price: { currency: o.currency, value: paiseToDecimal(Number(o.totalPaise)) }, breakup: (o.items as { breakup?: unknown[] } | null)?.breakup ?? [] },
    ...(o.cancelReason ? { cancellation: { reason: { id: o.cancelReason } } } : {}),
    created_at: o.createdAt.toISOString(),
    updated_at: o.updatedAt.toISOString(),
  };
}

export interface ReceiveOrderInput { context: BecknContext; body: unknown; sellerBusinessId: string; quote: { totalPaise: number; lines: QuoteLine[]; breakup: unknown[] } }

/**
 * Creates the OndcOrder for a /confirm (idempotent by transaction_id + message_id), then hands it to the order sink
 * and emits OndcOrderReceived exactly once (receivedEmittedAt is the guard; the sink dedupes on `externalRef`).
 */
export async function receiveOrder(i: ReceiveOrderInput): Promise<{ order: OrderRow & { bapId: string; bapUri: string }; created: boolean }> {
  let created = true;
  let row: (OrderRow & { bapId: string; bapUri: string; receivedEmittedAt: Date | null; transactionId: string }) | null = null;
  try {
    row = await prisma.ondcOrder.create({
      data: {
        transactionId: i.context.transaction_id, messageId: i.context.message_id, bapId: i.context.bap_id, bapUri: i.context.bap_uri,
        sellerBusinessId: i.sellerBusinessId, totalPaise: BigInt(i.quote.totalPaise), items: { lines: i.quote.lines, breakup: i.quote.breakup } as object,
        payload: i.body as object,
      },
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    created = false;
    row = await prisma.ondcOrder.findUniqueOrThrow({ where: { transactionId_messageId: { transactionId: i.context.transaction_id, messageId: i.context.message_id } } });
  }
  if (!row.receivedEmittedAt) row = await finishReceive(row, i.quote);
  return { order: row, created };
}

async function finishReceive<T extends OrderRow & { bapId: string; transactionId: string; receivedEmittedAt: Date | null }>(row: T, quote: ReceiveOrderInput["quote"]): Promise<T> {
  let internalOrderId: string | null = null;
  const sink = getOrderSink();
  if (sink) {
    try {
      const billing = ((row.payload as { message?: { order?: { billing?: { name?: string } } } })?.message?.order?.billing) ?? {};
      const r = await sink.recordExternalOrder({
        externalRef: `ondc:${row.id}`, source: "ondc", ondcOrderId: row.id, sellerBusinessId: row.sellerBusinessId,
        buyerLabel: typeof billing.name === "string" ? billing.name.slice(0, 120) : null, bapId: row.bapId, transactionId: row.transactionId,
        items: quote.lines.map((l) => ({ listingId: l.itemId, quantity: l.count, unitPricePaise: l.unitPaise, unit: l.unit })),
        totalPaise: Number(row.totalPaise), currency: "INR",
      });
      internalOrderId = r?.orderId ?? null;
    } catch (err) {
      // never lose the order because the mirror failed: it stays in the inbox and is re-offered on redelivery
      console.error("[ondc] order sink failed", err);
      return row;
    }
  }
  return prisma.$transaction(async (tx) => {
    const res = await tx.ondcOrder.updateMany({ where: { id: row.id, receivedEmittedAt: null }, data: { receivedEmittedAt: new Date(), internalOrderId } });
    if (res.count === 1) {
      await emit(tx, "OndcOrderReceived", { type: "ondc_order", id: row.id }, {
        ondcOrderId: row.id, orderId: internalOrderId, sellerBusinessId: row.sellerBusinessId, bapId: row.bapId, transactionId: row.transactionId,
      });
    }
    return { ...row, receivedEmittedAt: new Date() };
  });
}

// ---------------------------------------------------------------------------------------------
// Seller inbox
// ---------------------------------------------------------------------------------------------
export interface OndcOrderView {
  id: string; transactionId: string; bapId: string; status: OndcOrderStatus; totalPaise: number; currency: string;
  lines: { itemId: string; name: string; count: number; unitPaise: number }[]; cancelReason: string | null; internalOrderId: string | null; createdAt: string;
  /** last Beckn fulfilment state known/pushed (Packed, Order-picked-up, Out-for-delivery, Order-delivered, Cancelled), null before any */
  fulfilmentState: string | null;
}

const view = (o: { id: string; transactionId: string; bapId: string; status: string; totalPaise: bigint; currency: string; items: unknown; cancelReason: string | null; internalOrderId: string | null; createdAt: Date; fulfilmentState?: string | null }): OndcOrderView => ({
  id: o.id, transactionId: o.transactionId, bapId: o.bapId, status: o.status as OndcOrderStatus, totalPaise: Number(o.totalPaise), currency: o.currency,
  lines: ((o.items as { lines?: QuoteLine[] } | null)?.lines ?? []).map((l) => ({ itemId: l.itemId, name: l.name, count: l.count, unitPaise: l.unitPaise })),
  cancelReason: o.cancelReason, internalOrderId: o.internalOrderId, createdAt: o.createdAt.toISOString(),
  fulfilmentState: o.fulfilmentState ?? null,
});

export async function listSellerOrders(sellerBusinessId: string, opts: { status?: OndcOrderStatus; limit?: number } = {}): Promise<OndcOrderView[]> {
  const rows = await prisma.ondcOrder.findMany({
    where: { sellerBusinessId, ...(opts.status ? { status: opts.status } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: Math.min(100, opts.limit ?? 50),
  });
  return rows.map(view);
}

async function ownOrder(sellerBusinessId: string, id: string) {
  const o = UUID.test(id) ? await prisma.ondcOrder.findUnique({ where: { id } }) : null;
  if (!o || o.sellerBusinessId !== sellerBusinessId) throw new DomainError("not_found", "Order not found.", undefined, "ondc.orderNotFound");
  return o;
}

export function contextOf(payload: unknown): BecknContext {
  return (payload as { context: BecknContext }).context;
}

export async function transitionOrder(id: string, from: OndcOrderStatus[], to: OndcOrderStatus, extra: { cancelReason?: string } = {}) {
  const res = await prisma.ondcOrder.updateMany({ where: { id, status: { in: from } }, data: { status: to, ...extra } });
  if (res.count === 0) throw new DomainError("conflict", `This order can no longer be moved to ${to}.`);
  return prisma.ondcOrder.findUniqueOrThrow({ where: { id } });
}

/** Seller accepts a created order; the buyer app is told with an unsolicited on_status. */
export async function acceptOrder(sellerBusinessId: string, id: string, cfg: OndcConfig = loadConfig()): Promise<OndcOrderView> {
  const o = await ownOrder(sellerBusinessId, id);
  if (o.status === "accepted") return view(o); // idempotent
  const next = await transitionOrder(id, ["created"], "accepted");
  await mirrorDecision("accepted", next.internalOrderId, sellerBusinessId);
  await queueCallback({ inbound: contextOf(next.payload), action: "on_status", messageId: newMessageId(), message: { order: orderToBeckn(next) } }, cfg);
  return view(next);
}

/** Seller rejects (cancels) a created order; the buyer app gets on_cancel. `reasonId` is a Beckn cancellation reason code. */
export async function rejectOrder(sellerBusinessId: string, id: string, reasonId = "011", cfg: OndcConfig = loadConfig()): Promise<OndcOrderView> {
  const o = await ownOrder(sellerBusinessId, id);
  if (o.status === "cancelled") return view(o);
  const next = await transitionOrder(id, ["created"], "cancelled", { cancelReason: reasonId.slice(0, 20) });
  await mirrorDecision("rejected", next.internalOrderId, sellerBusinessId);
  await queueCallback({ inbound: contextOf(next.payload), action: "on_cancel", messageId: newMessageId(), message: { order: orderToBeckn(next) } }, cfg);
  return view(next);
}

/** System read for notifiers: the seller business behind an ONDC order. */
export async function getOndcOrderSeller(ondcOrderId: string): Promise<string | null> {
  if (!UUID.test(ondcOrderId)) return null;
  return (await prisma.ondcOrder.findUnique({ where: { id: ondcOrderId }, select: { sellerBusinessId: true } }))?.sellerBusinessId ?? null;
}
