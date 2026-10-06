// Escrow state machine (pure). created -> awaiting_funding -> funded -> accepted -> released | refunded.
// `cancelled` closes an escrow that never received money. "Frozen" (open dispute) is an overlay, not a status.
export type EscrowStatus = "created" | "awaiting_funding" | "funded" | "accepted" | "released" | "refunded" | "cancelled";
export type Milestone = "funded" | "confirmed" | "dispatched" | "delivered" | "accepted" | "released" | "refunded";
export type ReleaseCause = "buyer_accepted" | "auto_release" | "dispute_resolution" | "staff";
export type RefundCause = "cancelled" | "dispute_resolution" | "funding_expired" | "staff" | "return_credit";

export const TRANSITIONS: Record<EscrowStatus, readonly EscrowStatus[]> = {
  created: ["awaiting_funding", "cancelled"],
  awaiting_funding: ["funded", "cancelled"],
  funded: ["accepted", "released", "refunded"],
  accepted: ["released", "refunded"],
  released: [],
  refunded: [],
  cancelled: ["created"], // a lapsed, never-funded escrow can be re-opened by the buyer
};
export const TERMINAL_STATUSES: readonly EscrowStatus[] = ["released", "refunded", "cancelled"];
/** Money is held at the partner in these statuses. */
export const HOLDING_STATUSES: readonly EscrowStatus[] = ["funded", "accepted"];

export const canTransition = (from: EscrowStatus, to: EscrowStatus): boolean => TRANSITIONS[from].includes(to);
export const isTerminal = (s: EscrowStatus): boolean => s === "released" || s === "refunded" || s === "cancelled";
export const isHolding = (s: EscrowStatus): boolean => s === "funded" || s === "accepted";

/** Milestone that an Order status change corresponds to (`completed` = buyer accepted). */
export function milestoneForOrderStatus(to: string): "confirmed" | "dispatched" | "delivered" | "accepted" | null {
  switch (to) {
    case "confirmed": return "confirmed";
    case "dispatched": return "dispatched";
    case "delivered": return "delivered";
    case "completed": return "accepted";
    default: return null;
  }
}

/** Order statuses an escrow can still be opened for (before the seller dispatches). */
export const ESCROWABLE_ORDER_STATUSES = ["recorded", "confirmed"] as const;
