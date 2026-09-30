// Fulfilment status push (ADR-021): OrderStatusChanged on a platform order that mirrors an ONDC order becomes an
// unsolicited, signed `on_status` carrying the Beckn fulfilment state. Idempotent per (ONDC order, state): the message_id
// is derived from both, and queueCallback dedupes on (action, transaction, message_id). Delivery uses the ondc.callback queue.
import { prisma } from "@cnote/db";
import { loadConfig, type OndcConfig } from "./config";
import { detMessageId } from "./igm";
import { isKilled } from "./killswitch";
import { orderToBeckn, type OndcOrderStatus } from "./orders";
import { queueCallback } from "./outbound";
import type { BecknContext } from "./beckn";

/** Beckn fulfilment states we emit. */
export const FULFILMENT_STATES = ["Packed", "Order-picked-up", "Out-for-delivery", "Order-delivered", "Cancelled"] as const;
export type FulfilmentState = (typeof FULFILMENT_STATES)[number];

/** Platform order status -> [fulfilment state, ONDC order status]. `recorded` is the pre-acceptance state and is not pushed. */
export const FULFILMENT_MAP: Record<string, { state: FulfilmentState; order: OndcOrderStatus } | undefined> = {
  confirmed: { state: "Packed", order: "accepted" },
  dispatched: { state: "Order-picked-up", order: "in_progress" },
  delivered: { state: "Order-delivered", order: "in_progress" },
  completed: { state: "Order-delivered", order: "completed" },
  cancelled: { state: "Cancelled", order: "cancelled" },
};

const RANK: Record<OndcOrderStatus, number> = { created: 0, accepted: 1, in_progress: 2, completed: 3, cancelled: 3 };

/** Event handler for OrderStatusChanged. Returns true when a callback was queued. */
export async function onOrderStatusChanged(p: { orderId: string; to: string }, cfg: OndcConfig = loadConfig()): Promise<boolean> {
  if (!cfg.enabled || (await isKilled())) return false;
  const m = FULFILMENT_MAP[p.to];
  if (!m) return false;
  const o = await prisma.ondcOrder.findFirst({ where: { internalOrderId: p.orderId } });
  if (!o) return false;
  const cur = o.status as OndcOrderStatus;
  // already there (or past it): the seller accepted / rejected in the ONDC inbox, which sent its own callback
  if (cur === "cancelled" || (m.order !== "cancelled" && RANK[cur] > RANK[m.order]) || (p.to === "confirmed" && cur !== "created")) return false;
  if (o.fulfilmentState === m.state && cur === m.order) return false;
  const order = FULFILMENT_STATES.indexOf(o.fulfilmentState as FulfilmentState);
  if (m.state !== "Cancelled" && order > FULFILMENT_STATES.indexOf(m.state)) return false; // never move a fulfilment state backwards
  const res = await prisma.ondcOrder.updateMany({
    where: { id: o.id, status: { notIn: ["cancelled", "completed"] } },
    data: { status: m.order, fulfilmentState: m.state, ...(m.order === "cancelled" ? { cancelReason: "011" } : {}) },
  });
  if (res.count === 0) return false;
  const next = await prisma.ondcOrder.findUniqueOrThrow({ where: { id: o.id } });
  await queueCallback({
    inbound: (next.payload as { context: BecknContext }).context, action: "on_status", messageId: detMessageId(next.id, "fulfilment", m.state, m.order),
    message: { order: orderToBeckn(next) },
  }, cfg);
  return true;
}
