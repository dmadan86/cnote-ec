// Three-way match (PO vs goods receipt vs supplier invoice). Pure: no database, no clock. docs/design/grn-returns.md.
//
// Rules (all money in paise, quantities whole units, tolerances in basis points):
//  - Per PO line, the quantity billed so far (this invoice and the earlier live invoices of the PO, less credited rejected units) is compared
//    with the quantity the buyer ACCEPTED across all goods receipts. Billing less than accepted is fine (the rest is billed later); billing
//    more is "within tolerance" up to the buyer's quantity tolerance and a mismatch beyond it.
//  - Per invoice line, the unit price (excluding GST) is compared with the PO unit price in either direction against the price tolerance.
//  - An invoice without line detail is matched on its taxable value: the value billed so far against the value accepted at PO prices, with
//    the two tolerances combined.
//  - No goods receipt at all for the PO: "pending_grn" (nothing to match against yet).
//  - A line's status is the worse of its quantity and price status; an invoice's status is the worst of its lines.
import { createHash } from "node:crypto";

export type MatchStatus = "matched" | "within_tolerance" | "mismatch" | "pending_grn";

export interface Tolerances { qtyBps: number; priceBps: number }

export const MAX_TOLERANCE_BPS = 2000;
export const DEFAULT_QTY_TOLERANCE_BPS = 200;
export const DEFAULT_PRICE_TOLERANCE_BPS = 100;

/** Platform defaults (config MATCH_DEFAULT_QTY_TOLERANCE_BPS / MATCH_DEFAULT_PRICE_TOLERANCE_BPS); a buyer's own settings override them. */
export function defaultTolerances(env: NodeJS.ProcessEnv = process.env): Tolerances {
  const read = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && v !== "" && Number.isInteger(n) && n >= 0 && n <= MAX_TOLERANCE_BPS ? n : d; };
  return { qtyBps: read(env.MATCH_DEFAULT_QTY_TOLERANCE_BPS, DEFAULT_QTY_TOLERANCE_BPS), priceBps: read(env.MATCH_DEFAULT_PRICE_TOLERANCE_BPS, DEFAULT_PRICE_TOLERANCE_BPS) };
}

const SEVERITY: Record<MatchStatus, number> = { matched: 0, within_tolerance: 1, pending_grn: 2, mismatch: 3 };
export const worst = (...s: MatchStatus[]): MatchStatus => s.reduce<MatchStatus>((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), "matched");

export interface MatchPoLine { lineNo: number; description: string; unit: string; quantity: number; /** per unit, excluding GST */ unitPricePaise: number }

export interface MatchInvoiceLineIn { poLineNo: number; quantity: number; unitPricePaise: number }

export interface MatchInvoiceIn {
  id: string;
  number: string;
  taxablePaise: number;
  /** null = amount-only invoice */
  lines: MatchInvoiceLineIn[] | null;
  /** units of rejected stock returned and credited against this invoice, per PO line */
  creditedRejectedQty: { poLineNo: number; quantity: number }[];
  /** taxable value of credit notes against this invoice that relate to rejected units */
  creditedRejectedTaxablePaise: number;
}

export interface MatchInput {
  poLines: MatchPoLine[];
  /** accepted units summed over all goods receipts, per PO line */
  accepted: ReadonlyMap<number, number>;
  receiptCount: number;
  /** live (non-void) invoices of the PO, oldest first */
  invoices: MatchInvoiceIn[];
  tolerances: Tolerances;
}

export interface MatchLineResult {
  poLineNo: number;
  description: string;
  unit: string;
  poQty: number;
  poUnitPricePaise: number;
  acceptedQty: number;
  invoiceQty: number;
  invoiceUnitPricePaise: number;
  /** quantity billed by this and earlier invoices, less credited rejected units */
  billedQty: number;
  qtyStatus: MatchStatus;
  priceStatus: MatchStatus;
  status: MatchStatus;
}

export interface MatchAmountResult {
  /** taxable value billed by this and earlier invoices, less credited rejected value */
  billedPaise: number;
  /** taxable value accepted at PO prices */
  acceptedPaise: number;
  status: MatchStatus;
}

export interface InvoiceMatch {
  invoiceId: string;
  invoiceNumber: string;
  status: MatchStatus;
  basis: "line" | "amount";
  lines: MatchLineResult[];
  amount: MatchAmountResult;
  /** identifies the exact numbers behind a non-matching status, so an override applies only to what the buyer saw */
  fingerprint: string;
}

/** |a - b| <= tol% of base, all in integers (tol in basis points). */
const within = (diff: number, base: number, bps: number): boolean => Math.abs(diff) * 10_000 <= bps * base;

function qtyStatus(billed: number, accepted: number, bps: number): MatchStatus {
  if (billed <= accepted) return "matched";
  if (accepted === 0) return "mismatch";
  return within(billed - accepted, accepted, bps) ? "within_tolerance" : "mismatch";
}

function priceStatus(invoicePrice: number, poPrice: number, bps: number): MatchStatus {
  if (invoicePrice === poPrice) return "matched";
  if (poPrice === 0) return "mismatch";
  return within(invoicePrice - poPrice, poPrice, bps) ? "within_tolerance" : "mismatch";
}

function amountStatus(billed: number, accepted: number, t: Tolerances): MatchStatus {
  if (billed <= accepted) return "matched";
  if (accepted === 0) return "mismatch";
  // quantity and price tolerances compound: (1+q)(1+p) - 1, rounded up in basis points
  const combined = t.qtyBps + t.priceBps + Math.ceil((t.qtyBps * t.priceBps) / 10_000);
  return within(billed - accepted, accepted, combined) ? "within_tolerance" : "mismatch";
}

export function evaluateMatch(input: MatchInput): InvoiceMatch[] {
  const { poLines, accepted, receiptCount, tolerances } = input;
  const po = new Map(poLines.map((l) => [l.lineNo, l]));
  const acceptedValue = poLines.reduce((sum, l) => sum + (accepted.get(l.lineNo) ?? 0) * l.unitPricePaise, 0);
  const billedQty = new Map<number, number>();
  let billedPaise = 0;
  const out: InvoiceMatch[] = [];

  for (const inv of input.invoices) {
    for (const l of inv.lines ?? []) billedQty.set(l.poLineNo, (billedQty.get(l.poLineNo) ?? 0) + l.quantity);
    for (const c of inv.creditedRejectedQty) billedQty.set(c.poLineNo, (billedQty.get(c.poLineNo) ?? 0) - c.quantity);
    billedPaise += inv.taxablePaise - inv.creditedRejectedTaxablePaise;

    const lines: MatchLineResult[] = (inv.lines ?? []).map((l) => {
      const pl = po.get(l.poLineNo);
      const acc = accepted.get(l.poLineNo) ?? 0;
      const billed = billedQty.get(l.poLineNo) ?? l.quantity;
      if (!pl) return { poLineNo: l.poLineNo, description: "", unit: "", poQty: 0, poUnitPricePaise: 0, acceptedQty: acc, invoiceQty: l.quantity, invoiceUnitPricePaise: l.unitPricePaise, billedQty: billed, qtyStatus: "mismatch", priceStatus: "mismatch", status: "mismatch" };
      const q: MatchStatus = receiptCount === 0 ? "pending_grn" : qtyStatus(billed, acc, tolerances.qtyBps);
      const p = priceStatus(l.unitPricePaise, pl.unitPricePaise, tolerances.priceBps);
      return {
        poLineNo: l.poLineNo, description: pl.description, unit: pl.unit, poQty: pl.quantity, poUnitPricePaise: pl.unitPricePaise, acceptedQty: acc, invoiceQty: l.quantity,
        invoiceUnitPricePaise: l.unitPricePaise, billedQty: billed, qtyStatus: q, priceStatus: p, status: worst(q, p),
      };
    });

    const amount: MatchAmountResult = {
      billedPaise, acceptedPaise: acceptedValue,
      status: receiptCount === 0 ? "pending_grn" : amountStatus(billedPaise, acceptedValue, tolerances),
    };
    const basis = inv.lines ? "line" : "amount";
    const status = basis === "line" ? (lines.length ? worst(...lines.map((l) => l.status)) : "matched") : amount.status;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ basis, status, lines: lines.map((l) => [l.poLineNo, l.status, l.acceptedQty, l.billedQty, l.invoiceUnitPricePaise]), amount: basis === "amount" ? [amount.billedPaise, amount.acceptedPaise] : null }))
      .digest("hex").slice(0, 32);
    out.push({ invoiceId: inv.id, invoiceNumber: inv.number, status, basis, lines, amount, fingerprint });
  }
  return out;
}

export type PaymentGate = { blocked: false; reason: null } | { blocked: true; reason: "mismatch" | "pending_grn" };

/** Whether "mark paid" is blocked for an invoice: a mismatch always (unless overridden for this very fingerprint); pending GRN only if the buyer opted in. */
export function paymentGate(match: Pick<InvoiceMatch, "status" | "fingerprint">, opts: { blockPendingGrn: boolean; overriddenFingerprints: ReadonlySet<string> }): PaymentGate {
  if (match.status === "mismatch" && !opts.overriddenFingerprints.has(match.fingerprint)) return { blocked: true, reason: "mismatch" };
  if (match.status === "pending_grn" && opts.blockPendingGrn && !opts.overriddenFingerprints.has(match.fingerprint)) return { blocked: true, reason: "pending_grn" };
  return { blocked: false, reason: null };
}
