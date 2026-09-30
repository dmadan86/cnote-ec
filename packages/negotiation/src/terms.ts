// Structured quote terms (enquiry.Quote) mapped onto what the negotiation module needs. Pure, no I/O.
import type { DeliveryTerms, PaymentTerms, QuoteView } from "@cnote/enquiry";

export interface StructuredTerms {
  deliveryChargePaise: number | null;
  deliveryIncluded: boolean | null;
  gstIncluded: boolean | null;
  paymentTerms: PaymentTerms | null;
}

type TermsSource = Pick<QuoteView, "deliveryTerms" | "deliveryChargePaise" | "paymentTerms" | "gstIncluded">;

/** True when the seller filled at least one structured term (delivery, charge, payment, GST). Old quotes are false. */
export const hasStructuredTerms = (q: TermsSource): boolean =>
  q.deliveryTerms != null || q.deliveryChargePaise != null || q.paymentTerms != null || q.gstIncluded != null;

/**
 * Comparison inputs read straight from the structured fields. `deliveryChargePaise` is the total for the quoted quantity.
 * Ex-works / buyer pickup mean the seller charges no freight (0). A door delivery without a stated charge stays UNKNOWN:
 * we never guess that freight is included.
 */
export function structuredComparisonTerms(q: TermsSource): StructuredTerms {
  let charge = q.deliveryChargePaise;
  if (charge == null && (q.deliveryTerms === "ex_works" || q.deliveryTerms === "buyer_pickup")) charge = 0;
  return { deliveryChargePaise: charge, deliveryIncluded: charge == null ? null : charge === 0, gstIncluded: q.gstIncluded, paymentTerms: q.paymentTerms };
}

/** Best-effort mapping of the price book's / assistant's free-text shipping terms to the delivery enum (else "other" + the text as the note). */
export function mapShippingTerms(text: string | null | undefined): { deliveryTerms: DeliveryTerms | null; deliveryNote: string | null } {
  const t = (text ?? "").trim();
  if (!t) return { deliveryTerms: null, deliveryNote: null };
  const note = t.slice(0, 300);
  if (/\bex[\s_-]?works\b|\bexw\b/i.test(t)) return { deliveryTerms: "ex_works", deliveryNote: note };
  if (/\bfob\b/i.test(t)) return { deliveryTerms: "fob", deliveryNote: note };
  if (/pick[\s_-]?up|self[\s_-]?collect|collect(ed)? from/i.test(t)) return { deliveryTerms: "buyer_pickup", deliveryNote: note };
  if (/door|deliver(ed|y)? (to|at)|free (delivery|shipping)/i.test(t)) return { deliveryTerms: "door_delivery", deliveryNote: note };
  return { deliveryTerms: "other", deliveryNote: note };
}

/** Best-effort mapping of free-text payment terms to the payment enum (else "other" + the text as the note). Exact enum codes pass through. */
export function mapPaymentTerms(text: string | null | undefined): { paymentTerms: PaymentTerms | null; paymentNote: string | null } {
  const t = (text ?? "").trim();
  if (!t) return { paymentTerms: null, paymentNote: null };
  const note = t.slice(0, 300);
  if (/\bescrow\b/i.test(t)) return { paymentTerms: "escrow", paymentNote: note };
  const net = /\bnet[\s_-]?(7|15|30)\b|\b(7|15|30)[\s-]*days?\b/i.exec(t);
  if (net) return { paymentTerms: `net_${net[1] ?? net[2]}` as PaymentTerms, paymentNote: note };
  if (/on[\s_-]?delivery|\bcod\b|cash on/i.test(t)) return { paymentTerms: "on_delivery", paymentNote: note };
  if (/advance|prepaid|up[\s-]?front/i.test(t)) return { paymentTerms: "advance", paymentNote: note };
  return { paymentTerms: "other", paymentNote: note };
}
