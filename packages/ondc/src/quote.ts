// Quote computation for select/init/confirm (ADR-017): prices always come from the live catalogue, never from
// the request. Money is integer paise; Beckn decimals are produced at the edge only.
import { itemCount, type OrderItemInput } from "./beckn";
import { paiseToDecimal, type BecknProvider } from "./mapping";

export interface QuoteLine { itemId: string; name: string; count: number; unitPaise: number; linePaise: number; unit: string | null }
export interface Quote { totalPaise: number; lines: QuoteLine[]; breakup: unknown[]; message: Record<string, unknown> }
export type QuoteError = { type: "DOMAIN-ERROR"; code: string; message: string };

/** Beckn domain error codes we emit (confirm against ONDC's error-code sheet at certification, see docs/design/ondc.md). */
export const DOMAIN_ERRORS = {
  providerUnavailable: { type: "DOMAIN-ERROR" as const, code: "30001", message: "Provider not found or not accepting ONDC orders" },
  itemNotFound: { type: "DOMAIN-ERROR" as const, code: "30004", message: "Item not found" },
  belowMoq: { type: "DOMAIN-ERROR" as const, code: "40002", message: "Quantity is below the minimum order quantity" },
  orderNotFound: { type: "DOMAIN-ERROR" as const, code: "30004", message: "Order not found" },
  invalidState: { type: "DOMAIN-ERROR" as const, code: "45003", message: "Order cannot be cancelled in its current state" },
};

export function quoteOrder(provider: BecknProvider | null, items: OrderItemInput[]): { quote: Quote } | { error: QuoteError } {
  if (!provider) return { error: DOMAIN_ERRORS.providerUnavailable };
  const byId = new Map(provider.items.map((i) => [i.id, i]));
  const lines: QuoteLine[] = [];
  for (const it of items) {
    const item = byId.get(it.id);
    if (!item) return { error: { ...DOMAIN_ERRORS.itemNotFound, message: `Item ${it.id.slice(0, 40)} is not available` } };
    const count = itemCount(it);
    const moq = Number(item.quantity.minimum?.count ?? 0);
    if (count < moq) return { error: { ...DOMAIN_ERRORS.belowMoq, message: `Minimum order quantity for ${item.id.slice(0, 40)} is ${moq}` } };
    const unitPaise = Math.round(Number(item.price.value) * 100);
    lines.push({ itemId: item.id, name: item.descriptor.name, count, unitPaise, linePaise: unitPaise * count, unit: item.quantity.unitized.measure.unit });
  }
  const totalPaise = lines.reduce((s, l) => s + l.linePaise, 0);
  const cur = "INR";
  const breakup = lines.map((l) => ({
    title: l.name, "@ondc/org/item_id": l.itemId, "@ondc/org/item_quantity": { count: l.count }, "@ondc/org/title_type": "item",
    price: { currency: cur, value: paiseToDecimal(l.linePaise) }, item: { price: { currency: cur, value: paiseToDecimal(l.unitPaise) } },
  }));
  return { quote: { totalPaise, lines, breakup, message: { price: { currency: cur, value: paiseToDecimal(totalPaise) }, breakup, ttl: "P1D" } } };
}
