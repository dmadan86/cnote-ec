// Order fulfilment sub-stages (wave 8): packed -> in_transit -> out_for_delivery -> delivery_attempted, recorded by the
// SELLER alongside the main order status machine. They never change `Order.status`, so escrow milestones (which key on
// the status) are unaffected. History is append-only (`OrderFulfilmentEvent`); the ONDC module mirrors the stages to
// Beckn fulfilment states through the OrderFulfilmentUpdated event (ADR-021).
import { DomainError, emit } from "@cnote/core";
import { prisma, type FulfilmentStage, type OrderStatus } from "@cnote/db";
import type { Actor } from "./types";
import type { OrderRole } from "./orders";

export type { FulfilmentStage };

/** Forward-only order of the sub-stages. */
export const FULFILMENT_STAGES: readonly FulfilmentStage[] = ["packed", "in_transit", "out_for_delivery", "delivery_attempted"];

/** Order statuses in which each stage may be recorded: packed before dispatch, the rest after it. */
export const FULFILMENT_RULES: Record<FulfilmentStage, { from: OrderStatus[] }> = {
  packed: { from: ["confirmed"] },
  in_transit: { from: ["dispatched"] },
  out_for_delivery: { from: ["dispatched"] },
  delivery_attempted: { from: ["dispatched"] },
};

export interface FulfilmentState {
  status: OrderStatus;
  fulfilmentStage: FulfilmentStage | null;
}

export interface FulfilmentInput {
  stage: FulfilmentStage;
  note?: string | null;
  courier?: string | null;
  trackingRef?: string | null;
}

const rank = (s: FulfilmentStage | null): number => (s ? FULFILMENT_STAGES.indexOf(s) : -1);

/**
 * Applies one fulfilment move (pure). Only the seller records stages. Returns `changed: false` when the order is
 * already at that stage (idempotent retry). Throws forbidden / conflict / validation DomainErrors otherwise.
 */
export function applyFulfilment(s: FulfilmentState, role: OrderRole, stage: FulfilmentStage): { changed: boolean; stage: FulfilmentStage } {
  const rule = (FULFILMENT_RULES as Record<string, { from: OrderStatus[] } | undefined>)[stage];
  if (!rule) throw new DomainError("validation", "Unknown fulfilment stage.", undefined, "enquiries.unknownFulfilmentStage");
  if (role !== "seller") throw new DomainError("forbidden", "Only the seller can record fulfilment progress.", undefined, "enquiries.onlySellerRecordFulfilmentProgress");
  if (!rule.from.includes(s.status)) {
    const why = s.status === "delivered" || s.status === "completed" || s.status === "cancelled"
      ? `An order that is ${s.status} can no longer be updated.`
      : stage === "packed"
        ? `An order that is ${s.status} cannot be marked packed.`
        : `Mark the order dispatched before recording ${stage.replace(/_/g, " ")}.`;
    throw new DomainError("conflict", why);
  }
  const cur = rank(s.fulfilmentStage);
  const next = rank(stage);
  if (next === cur) return { changed: false, stage };
  if (next < cur) throw new DomainError("conflict", "Fulfilment progress cannot move backwards.", undefined, "enquiries.fulfilmentProgressMoveBackwards");
  return { changed: true, stage };
}

/** Stages this role may record next (drives the seller controls; the function re-checks on every call). */
export function availableFulfilmentStages(s: FulfilmentState, role: OrderRole): FulfilmentStage[] {
  if (role !== "seller") return [];
  return FULFILMENT_STAGES.filter((st) => {
    try { return applyFulfilment(s, role, st).changed; } catch { return false; }
  });
}

const clean = (v: string | null | undefined, max: number, label: string): string | null => {
  if (v == null) return null;
  const t = v.replace(/\s+/g, " ").trim();
  if (t === "") return null;
  // eslint-disable-next-line no-control-regex
  if (t.length > max || /[\u0000-\u001f\u007f]/.test(t)) throw new DomainError("validation", `${label} must be at most ${max} characters.`);
  return t;
};

export interface FulfilmentEventView {
  id: string;
  stage: FulfilmentStage;
  note: string | null;
  courier: string | null;
  trackingRef: string | null;
  createdAt: string;
}

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Records the next fulfilment stage of an order the seller owns. Locks the order row, validates, appends a history row,
 * updates the latest-stage columns and emits OrderFulfilmentUpdated in the same transaction. Idempotent for a repeat of
 * the current stage (no row, no event). Tracking details given here replace the previous ones; omitted ones are kept.
 */
export async function recordFulfilmentStage(actor: Actor, orderId: string, input: FulfilmentInput): Promise<{ changed: boolean }> {
  if (!UUID.test(orderId)) throw new DomainError("not_found", "Order not found");
  const note = clean(input.note, 500, "Note");
  const courier = clean(input.courier, 80, "Courier");
  const trackingRef = clean(input.trackingRef, 80, "Tracking reference");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    const order = await tx.order.findUnique({ where: { id: orderId } });
    const role: OrderRole | null = !order ? null : order.sellerBusinessId === actor.businessId ? "seller" : order.buyerBusinessId === actor.businessId ? "buyer" : null;
    if (!order || !role) throw new DomainError("not_found", "Order not found");
    const r = applyFulfilment(order, role, input.stage);
    if (!r.changed) return { changed: false };
    const now = new Date();
    await tx.order.update({
      where: { id: order.id },
      data: {
        fulfilmentStage: r.stage,
        fulfilmentUpdatedAt: now,
        ...(courier ? { trackingCourier: courier } : {}),
        ...(trackingRef ? { trackingRef } : {}),
      },
    });
    await tx.orderFulfilmentEvent.create({
      data: { orderId: order.id, stage: r.stage, note, courier: courier ?? order.trackingCourier, trackingRef: trackingRef ?? order.trackingRef, actorBusinessId: actor.businessId, createdAt: now },
    });
    await emit(tx, "OrderFulfilmentUpdated", { type: "order", id: order.id }, {
      orderId: order.id, buyerBusinessId: order.buyerBusinessId, sellerBusinessId: order.sellerBusinessId, stage: r.stage, note,
    });
    return { changed: true };
  });
}

/** Tracking timeline (oldest first) for a participant of the order; empty for anyone else. */
export async function listFulfilmentEvents(actor: Actor, orderId: string): Promise<FulfilmentEventView[]> {
  if (!UUID.test(orderId)) return [];
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { buyerBusinessId: true, sellerBusinessId: true } });
  if (!o || (o.buyerBusinessId !== actor.businessId && o.sellerBusinessId !== actor.businessId)) return [];
  const rows = await prisma.orderFulfilmentEvent.findMany({ where: { orderId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return rows.map((r) => ({ id: r.id, stage: r.stage, note: r.note, courier: r.courier, trackingRef: r.trackingRef, createdAt: r.createdAt.toISOString() }));
}

// ---------------------------------------------------------------------------------------------
// Tracking timeline (pure; shared by the buyer and seller pages)
// ---------------------------------------------------------------------------------------------

export const TRACKING_STEPS = ["packed", "dispatched", "in_transit", "out_for_delivery", "delivered"] as const;
export type TrackingStep = (typeof TRACKING_STEPS)[number];
export type TrackingState = "done" | "current" | "upcoming";

/**
 * Steps of the buyer-visible timeline with their state: `dispatched` and `delivered` come from the main status, the rest
 * from the seller-recorded stage (a later status implies the earlier steps, so skipping a stage never leaves a gap).
 * `delivery_attempted` sits on the out_for_delivery step (its note explains it). Cancelled orders have no timeline.
 */
export function trackingSteps(s: FulfilmentState): { step: TrackingStep; state: TrackingState }[] {
  if (s.status === "cancelled") return [];
  const byStatus = s.status === "delivered" || s.status === "completed" ? 4 : s.status === "dispatched" ? 1 : -1;
  const byStage = s.fulfilmentStage === null ? -1 : ({ packed: 0, in_transit: 2, out_for_delivery: 3, delivery_attempted: 3 } as const)[s.fulfilmentStage];
  const p = Math.max(byStatus, byStage);
  return TRACKING_STEPS.map((step, i) => ({ step, state: p >= 4 || i < p ? "done" : i === p ? "current" : "upcoming" }));
}
