// Order sink port (ADR-017 / ADR-006): enquiry owns the Order model. Until it exposes a public function for
// externally sourced orders, ONDC orders stay in the ONDC inbox for seller action. The lead wires
// `setOrderSink({ recordExternalOrder })` in the worker/api bootstrap once enquiry ships it.
export interface ExternalOrderInput {
  /** idempotency key; the sink MUST return the same order for the same key ("ondc:<ondcOrderId>") */
  externalRef: string;
  source: "ondc";
  ondcOrderId: string;
  sellerBusinessId: string;
  /** the network buyer has no platform business; human label from the Beckn billing block, may be null */
  buyerLabel: string | null;
  bapId: string;
  transactionId: string;
  items: { listingId: string; quantity: number; unitPricePaise: number; unit: string | null }[];
  totalPaise: number;
  currency: "INR";
}

export interface OrderSink {
  recordExternalOrder(input: ExternalOrderInput): Promise<{ orderId: string } | null>;
  /** seller accepted in the ONDC inbox: confirm the mirrored platform order (best effort) */
  onAccepted?(orderId: string, sellerBusinessId: string): Promise<void>;
  /** seller rejected: cancel the mirrored platform order (best effort) */
  onRejected?(orderId: string, sellerBusinessId: string): Promise<void>;
}

/** Keeps the platform order in step with the ONDC inbox; a failure never blocks the network callback. */
export async function mirrorDecision(kind: "accepted" | "rejected", orderId: string | null, sellerBusinessId: string): Promise<void> {
  if (!sink || !orderId) return;
  try {
    if (kind === "accepted") await sink.onAccepted?.(orderId, sellerBusinessId);
    else await sink.onRejected?.(orderId, sellerBusinessId);
  } catch (err) {
    console.error(`[ondc] order mirror (${kind}) failed`, err);
  }
}

let sink: OrderSink | null = null;
export const getOrderSink = (): OrderSink | null => sink;
export function setOrderSink(s: OrderSink | null): void {
  sink = s;
}
