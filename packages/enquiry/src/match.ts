// Three-way match service: loads the PO lines, the goods receipts and the supplier invoices (and credited returns), runs the pure rules in
// match-core.ts and exposes the result to both parties, plus the buyer's tolerances and the "mark paid" gate. docs/design/grn-returns.md.
import { DomainError } from "@cnote/core";
import { prisma, type SupplierInvoice, type Tx } from "@cnote/db";
import { MAX_TOLERANCE_BPS, defaultTolerances, evaluateMatch, paymentGate, type InvoiceMatch, type MatchInvoiceIn, type MatchPoLine, type PaymentGate, type Tolerances } from "./match-core";
import { assertPurchaseOrdersEnabled } from "./supplier-invoices";
import type { Actor } from "./types";

const UUID = /^[0-9a-f-]{36}$/i;
type Db = Pick<Tx, "purchaseOrder" | "purchaseOrderLine" | "goodsReceiptLine" | "supplierInvoice" | "buyerMatchSettings" | "invoiceMatchOverride" | "returnCreditNote">;

// ---- buyer settings --------------------------------------------------------------------------------------------------------------

export interface MatchSettingsView { qtyToleranceBps: number; priceToleranceBps: number; blockPendingGrn: boolean; /** false = platform defaults */ custom: boolean }

export async function getBuyerMatchSettings(buyerBusinessId: string, db: Pick<Db, "buyerMatchSettings"> = prisma): Promise<MatchSettingsView> {
  const row = await db.buyerMatchSettings.findUnique({ where: { buyerBusinessId } });
  if (row) return { qtyToleranceBps: row.qtyToleranceBps, priceToleranceBps: row.priceToleranceBps, blockPendingGrn: row.blockPendingGrn, custom: true };
  const d = defaultTolerances();
  return { qtyToleranceBps: d.qtyBps, priceToleranceBps: d.priceBps, blockPendingGrn: false, custom: false };
}

export interface MatchSettingsInput { qtyToleranceBps: number; priceToleranceBps: number; blockPendingGrn?: boolean }

export async function setBuyerMatchSettings(actor: Actor, input: MatchSettingsInput): Promise<MatchSettingsView> {
  assertPurchaseOrdersEnabled();
  const ok = (n: number) => Number.isInteger(n) && n >= 0 && n <= MAX_TOLERANCE_BPS;
  if (!ok(input.qtyToleranceBps)) throw new DomainError("validation", `Quantity tolerance must be between 0% and ${MAX_TOLERANCE_BPS / 100}%.`, { qtyTolerance: "Enter 0 to 20." });
  if (!ok(input.priceToleranceBps)) throw new DomainError("validation", `Price tolerance must be between 0% and ${MAX_TOLERANCE_BPS / 100}%.`, { priceTolerance: "Enter 0 to 20." });
  const data = { qtyToleranceBps: input.qtyToleranceBps, priceToleranceBps: input.priceToleranceBps, blockPendingGrn: !!input.blockPendingGrn, updatedByPersonId: actor.personId };
  await prisma.buyerMatchSettings.upsert({ where: { buyerBusinessId: actor.businessId }, create: { buyerBusinessId: actor.businessId, ...data }, update: data });
  return getBuyerMatchSettings(actor.businessId);
}

// ---- loading and evaluating ------------------------------------------------------------------------------------------------------

export interface PoLineSummary {
  lineNo: number;
  description: string;
  unit: string;
  orderedQty: number;
  unitPricePaise: number;
  receivedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  /** units billed by live invoices with line detail, less credited rejected units */
  billedQty: number;
}

export interface Evaluated {
  poLines: MatchPoLine[];
  lines: PoLineSummary[];
  receiptCount: number;
  results: InvoiceMatch[];
  invoices: SupplierInvoice[];
  tolerances: Tolerances;
  settings: MatchSettingsView;
  overrides: { invoiceId: string; fingerprint: string; reason: string; byPersonId: string; createdAt: Date }[];
}

/** Evaluates every live invoice of a PO (oldest first). `db` is a transaction client when the caller already holds locks. */
export async function evaluatePurchaseOrder(db: Db, purchaseOrderId: string): Promise<Evaluated | null> {
  const po = await db.purchaseOrder.findUnique({ where: { id: purchaseOrderId }, include: { versions: true } });
  if (!po) return null;
  const ver = po.versions.find((v) => v.version === po.currentVersion);
  if (!ver) return null;
  const [poLineRows, receiptLines, invoices, settings] = await Promise.all([
    db.purchaseOrderLine.findMany({ where: { versionId: ver.id }, orderBy: { lineNo: "asc" } }),
    db.goodsReceiptLine.findMany({ where: { receipt: { purchaseOrderId } }, select: { poLineNo: true, receivedQty: true, acceptedQty: true, rejectedQty: true, receiptId: true } }),
    db.supplierInvoice.findMany({
      where: { purchaseOrderId, status: { not: "void" } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: { lines: { orderBy: { lineNo: "asc" } }, creditNotes: { include: { goodsReturn: { include: { lines: true } } } } },
    }),
    getBuyerMatchSettings(po.buyerBusinessId, db),
  ]);
  const tolerances: Tolerances = { qtyBps: settings.qtyToleranceBps, priceBps: settings.priceToleranceBps };
  const poLines: MatchPoLine[] = poLineRows.map((l) => ({
    lineNo: l.lineNo, description: l.description, unit: l.unit, quantity: l.quantity,
    // net of GST: a GST-inclusive quote price is converted through the line's own taxable value
    unitPricePaise: l.quantity > 0 ? Math.round(Number(l.taxablePaise) / l.quantity) : Number(l.unitPricePaise),
  }));
  const accepted = new Map<number, number>();
  const received = new Map<number, number>();
  const rejected = new Map<number, number>();
  const add = (m: Map<number, number>, k: number, n: number) => m.set(k, (m.get(k) ?? 0) + n);
  for (const r of receiptLines) { add(accepted, r.poLineNo, r.acceptedQty); add(received, r.poLineNo, r.receivedQty); add(rejected, r.poLineNo, r.rejectedQty); }
  const receiptCount = new Set(receiptLines.map((r) => r.receiptId)).size;

  const ins: MatchInvoiceIn[] = invoices.map((inv) => {
    const creditedRejectedQty: { poLineNo: number; quantity: number }[] = [];
    let creditedRejectedTaxablePaise = 0;
    for (const cn of inv.creditNotes) {
      const lines = cn.goodsReturn.lines;
      const rej = lines.filter((l) => l.source === "rejected");
      for (const l of rej) creditedRejectedQty.push({ poLineNo: l.poLineNo, quantity: l.quantity });
      const total = lines.reduce((s, l) => s + BigInt(l.quantity) * l.unitPricePaise, 0n);
      const rejVal = rej.reduce((s, l) => s + BigInt(l.quantity) * l.unitPricePaise, 0n);
      if (total > 0n) creditedRejectedTaxablePaise += Number((cn.taxablePaise * rejVal) / total);
    }
    return {
      id: inv.id, number: inv.invoiceNumber, taxablePaise: Number(inv.taxablePaise),
      lines: inv.lines.length ? inv.lines.map((l) => ({ poLineNo: l.poLineNo, quantity: l.quantity, unitPricePaise: Number(l.unitPricePaise) })) : null,
      creditedRejectedQty, creditedRejectedTaxablePaise,
    };
  });
  const results = evaluateMatch({ poLines, accepted, receiptCount, invoices: ins, tolerances });

  const billed = new Map<number, number>();
  for (const i of ins) {
    for (const l of i.lines ?? []) add(billed, l.poLineNo, l.quantity);
    for (const c of i.creditedRejectedQty) add(billed, c.poLineNo, -c.quantity);
  }
  const lines: PoLineSummary[] = poLines.map((l) => ({
    lineNo: l.lineNo, description: l.description, unit: l.unit, orderedQty: l.quantity, unitPricePaise: l.unitPricePaise,
    receivedQty: received.get(l.lineNo) ?? 0, acceptedQty: accepted.get(l.lineNo) ?? 0, rejectedQty: rejected.get(l.lineNo) ?? 0, billedQty: billed.get(l.lineNo) ?? 0,
  }));
  const overrides = await db.invoiceMatchOverride.findMany({ where: { invoiceId: { in: invoices.map((i) => i.id) } }, orderBy: { createdAt: "asc" } });
  return { poLines, lines, receiptCount, results, invoices, tolerances, settings, overrides };
}

/** JSON snapshot stored with an override. */
export function matchSummaryJson(m: InvoiceMatch): object {
  return {
    status: m.status, basis: m.basis,
    lines: m.lines.map((l) => ({ poLineNo: l.poLineNo, status: l.status, qtyStatus: l.qtyStatus, priceStatus: l.priceStatus, acceptedQty: l.acceptedQty, billedQty: l.billedQty, invoiceUnitPricePaise: l.invoiceUnitPricePaise, poUnitPricePaise: l.poUnitPricePaise })),
    amount: m.amount,
  };
}

/** The payment gate for one invoice, evaluated inside the paying transaction. */
export async function matchGateTx(tx: Tx, inv: Pick<SupplierInvoice, "id" | "purchaseOrderId">): Promise<{ match: InvoiceMatch; gate: PaymentGate }> {
  const ev = await evaluatePurchaseOrder(tx, inv.purchaseOrderId);
  const match = ev?.results.find((r) => r.invoiceId === inv.id);
  if (!ev || !match) throw new DomainError("not_found", "Invoice not found");
  const fingerprints = new Set(ev.overrides.filter((o) => o.invoiceId === inv.id).map((o) => o.fingerprint));
  return { match, gate: paymentGate(match, { blockPendingGrn: ev.settings.blockPendingGrn, overriddenFingerprints: fingerprints }) };
}

// ---- views -------------------------------------------------------------------------------------------------------------------------

export interface InvoiceMatchView extends InvoiceMatch {
  /** buyer only: whether "mark paid" is blocked right now */
  gate: PaymentGate | null;
  /** buyer only: the logged overrides for this invoice */
  overrides: { reason: string; at: string; matchedNow: boolean }[];
}

export interface PoMatchView {
  purchaseOrderId: string;
  number: string;
  role: "buyer" | "seller";
  receiptCount: number;
  tolerances: { qtyBps: number; priceBps: number; blockPendingGrn: boolean; custom: boolean };
  lines: PoLineSummary[];
  invoices: InvoiceMatchView[];
  /** worst status over live invoices; "pending_grn" when there is no receipt yet; null when nothing is invoiced */
  overall: InvoiceMatch["status"] | null;
}

/** The three-way match of a PO as seen by its buyer or seller. */
export async function getPurchaseOrderMatch(actor: Actor, purchaseOrderId: string): Promise<PoMatchView | null> {
  if (!UUID.test(purchaseOrderId)) return null;
  const po = await prisma.purchaseOrder.findUnique({ where: { id: purchaseOrderId }, select: { id: true, number: true, buyerBusinessId: true, sellerBusinessId: true } });
  if (!po || (po.buyerBusinessId !== actor.businessId && po.sellerBusinessId !== actor.businessId)) return null;
  const role = po.buyerBusinessId === actor.businessId ? "buyer" : "seller";
  const ev = await evaluatePurchaseOrder(prisma, po.id);
  if (!ev) return null;
  const rank = { matched: 0, within_tolerance: 1, pending_grn: 2, mismatch: 3 } as const;
  const overall = ev.results.length ? ev.results.reduce((a, r) => (rank[r.status] > rank[a] ? r.status : a), "matched" as InvoiceMatch["status"]) : null;
  return {
    purchaseOrderId: po.id, number: po.number, role, receiptCount: ev.receiptCount,
    tolerances: { qtyBps: ev.settings.qtyToleranceBps, priceBps: ev.settings.priceToleranceBps, blockPendingGrn: ev.settings.blockPendingGrn, custom: ev.settings.custom },
    lines: ev.lines,
    invoices: ev.results.map((r) => {
      const mine = ev.overrides.filter((o) => o.invoiceId === r.invoiceId);
      const fps = new Set(mine.map((o) => o.fingerprint));
      return {
        ...r,
        gate: role === "buyer" ? paymentGate(r, { blockPendingGrn: ev.settings.blockPendingGrn, overriddenFingerprints: fps }) : null,
        overrides: role === "buyer" ? mine.map((o) => ({ reason: o.reason, at: o.createdAt.toISOString(), matchedNow: o.fingerprint === r.fingerprint })) : [],
      };
    }),
    overall,
  };
}
