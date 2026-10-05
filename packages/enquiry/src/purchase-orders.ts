// Purchase orders (buyer-issued, seller-acknowledged), per docs/design/purchase-orders.md.
// A PO is a stable header plus immutable versions: an amendment adds a version and never edits a sent one. The seller's answer
// (accept / reject) is an append-only row per version. The number is gap-free per buyer business and Indian financial year.
// Phase 1 settles off-platform (ADR-007): the PO is a commercial document, no money moves through it.
import { financialYear } from "@cnote/billing";
import { DomainError, emit } from "@cnote/core";
import { prisma, type Order, type Prisma, type PurchaseOrder, type PurchaseOrderAck, type PurchaseOrderLine, type PurchaseOrderVersion, type Tx } from "@cnote/db";
import * as identity from "@cnote/identity";
import { getMediaStore } from "@cnote/media";
import { createHash } from "node:crypto";
import {
  addDays, computePo, formatPoNumber, fromDbDate, isIntraState, isIsoDate, istDate, MAX_PAYMENT_TERMS_DAYS, paymentTermsToDays, toDbDate,
  type PoLine, type PoLineInput, type PoTotals,
} from "./po-core";
import { qrSvgDataUri } from "./einvoice";
import { renderPurchaseOrderPdf, type AddressSnapshot, type PartySnapshot } from "./po-pdf";
import { assertPurchaseOrdersEnabled, toInvoiceView, voidOpenInvoicesForOrderTx, type SupplierInvoiceView } from "./supplier-invoices";
import type { Actor } from "./types";

const UUID = /^[0-9a-f-]{36}$/i;
export const DEFAULT_PO_GST_RATE_BPS = 1800;

/** Default GST rate for a line derived from the order when the buyer does not state one (config: PO_DEFAULT_GST_RATE_BPS). */
export function defaultPoGstRateBps(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PO_DEFAULT_GST_RATE_BPS);
  return Number.isInteger(n) && n >= 0 && n <= 4000 ? n : DEFAULT_PO_GST_RATE_BPS;
}

// ---- views ---------------------------------------------------------------------------------------------------------------------

export type AckState = "pending" | "accepted" | "rejected";

export interface PoPartyView {
  businessId: string;
  name: string;
  legalName: string | null;
  /** the full GSTIN, only for the viewer's own side */
  gstin: string | null;
  /** the counterparty's GSTIN as state code + last four, never the middle characters */
  gstinMasked: string | null;
  stateCode: string | null;
}

export interface PoVersionSummary {
  version: number;
  createdAt: string;
  totalPaise: number;
  paymentTermsDays: number;
  ack: AckState;
  ackReason: string | null;
  ackAt: string | null;
  hasPdf: boolean;
}

export interface PoLineView extends Omit<PoLine, "quoteId"> { quoteId: string | null }

export interface PurchaseOrderView {
  id: string;
  orderId: string;
  number: string;
  financialYear: string;
  status: "issued" | "acknowledged" | "rejected" | "cancelled";
  role: "buyer" | "seller";
  currentVersion: number;
  buyer: PoPartyView;
  seller: PoPartyView;
  deliveryAddress: AddressSnapshot;
  placeOfSupply: string;
  intraState: boolean;
  paymentTermsDays: number;
  expectedDelivery: string | null;
  notes: string | null;
  lines: PoLineView[];
  totals: PoTotals;
  versions: PoVersionSummary[];
  cancelReason: string | null;
  cancelledAt: string | null;
  createdAt: string;
  /** the seller's own MSME standing (declared) and whether the payment-time limit applies to this supplier */
  sellerMsme: { category: "micro" | "small" | "medium" | null; covered: boolean };
  invoices: SupplierInvoiceView[];
  amounts: { poPaise: number; invoicedPaise: number; paidPaise: number; remainingToInvoicePaise: number; outstandingPaise: number };
  actions: { amend: boolean; cancel: boolean; acknowledge: boolean; recordInvoice: boolean; payInvoices: boolean };
}

type VersionFull = PurchaseOrderVersion & { lines: PurchaseOrderLine[]; acks: PurchaseOrderAck[] };

function ackOf(v: Pick<VersionFull, "acks">): { state: AckState; reason: string | null; at: Date | null } {
  const last = [...v.acks].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).at(-1);
  return last ? { state: last.decision === "accepted" ? "accepted" : "rejected", reason: last.reason, at: last.createdAt } : { state: "pending", reason: null, at: null };
}

const lineView = (l: PurchaseOrderLine): PoLineView => ({
  lineNo: l.lineNo, description: l.description, hsn: l.hsn, quantity: l.quantity, unit: l.unit, unitPricePaise: Number(l.unitPricePaise), priceIncludesGst: l.priceIncludesGst,
  gstRateBps: l.gstRateBps, taxablePaise: Number(l.taxablePaise), taxPaise: Number(l.taxPaise), totalPaise: Number(l.totalPaise), quoteId: l.quoteId,
});

type PoFull = PurchaseOrder & { versions: VersionFull[]; invoices: Parameters<typeof toInvoiceView>[0][] };

function partyView(snap: PartySnapshot, businessId: string, own: boolean): PoPartyView {
  return {
    businessId, name: snap.name, legalName: snap.legalName, gstin: own ? snap.gstin : null,
    gstinMasked: own ? null : identity.maskGstin(snap.gstin), stateCode: snap.stateCode,
  };
}

async function buildView(po: PoFull, role: "buyer" | "seller", now: Date): Promise<PurchaseOrderView> {
  const cur = po.versions.find((v) => v.version === po.currentVersion)!;
  const buyer = cur.buyer as unknown as PartySnapshot;
  const seller = cur.seller as unknown as PartySnapshot;
  const msme = (await identity.getPartyProfiles([po.sellerBusinessId])).get(po.sellerBusinessId)?.msme;
  const invoices = (await Promise.all(po.invoices.map(async (i) => toInvoiceView(i, now, i.irn && i.signedQr ? await qrSvgDataUri(i.signedQr) : undefined)))).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const live = invoices.filter((i) => i.status !== "void");
  const invoiced = live.reduce((s, i) => s + i.totalPaise, 0);
  const paid = live.reduce((s, i) => s + i.paidPaise, 0);
  const poPaise = Number(cur.totalPaise);
  const cancelled = po.status === "cancelled";
  const canInvoice = (po.status === "issued" || po.status === "acknowledged") && poPaise - invoiced > 0;
  return {
    id: po.id, orderId: po.orderId, number: po.number, financialYear: po.financialYear, status: po.status, role, currentVersion: po.currentVersion,
    buyer: partyView(buyer, po.buyerBusinessId, role === "buyer"), seller: partyView(seller, po.sellerBusinessId, role === "seller"),
    deliveryAddress: cur.deliveryAddress as unknown as AddressSnapshot, placeOfSupply: cur.placeOfSupply, intraState: cur.intraState,
    paymentTermsDays: cur.paymentTermsDays, expectedDelivery: cur.expectedDelivery ? fromDbDate(cur.expectedDelivery) : null, notes: cur.notes,
    lines: [...cur.lines].sort((a, b) => a.lineNo - b.lineNo).map(lineView),
    totals: { taxablePaise: Number(cur.taxablePaise), cgstPaise: Number(cur.cgstPaise), sgstPaise: Number(cur.sgstPaise), igstPaise: Number(cur.igstPaise), taxPaise: Number(cur.cgstPaise + cur.sgstPaise + cur.igstPaise), totalPaise: poPaise },
    versions: [...po.versions].sort((a, b) => b.version - a.version).map((v) => {
      const a = ackOf(v);
      return { version: v.version, createdAt: v.createdAt.toISOString(), totalPaise: Number(v.totalPaise), paymentTermsDays: v.paymentTermsDays, ack: a.state, ackReason: a.reason, ackAt: a.at?.toISOString() ?? null, hasPdf: !!v.pdfKey };
    }),
    cancelReason: po.cancelReason, cancelledAt: po.cancelledAt?.toISOString() ?? null, createdAt: po.createdAt.toISOString(),
    sellerMsme: { category: msme?.category ?? null, covered: !!msme?.covered },
    invoices,
    amounts: { poPaise, invoicedPaise: invoiced, paidPaise: paid, remainingToInvoicePaise: Math.max(0, poPaise - invoiced), outstandingPaise: invoiced - paid },
    actions: {
      amend: role === "buyer" && !cancelled,
      cancel: role === "buyer" && !cancelled && live.length === 0,
      acknowledge: role === "seller" && po.status === "issued",
      recordInvoice: role === "seller" && canInvoice,
      payInvoices: role === "buyer" && !cancelled,
    },
  };
}

const INCLUDE = {
  versions: { include: { lines: true, acks: true } },
  invoices: { include: { payments: true } },
} satisfies Prisma.PurchaseOrderInclude;

function roleOf(po: Pick<PurchaseOrder, "buyerBusinessId" | "sellerBusinessId">, actor: Actor): "buyer" | "seller" | null {
  return po.buyerBusinessId === actor.businessId ? "buyer" : po.sellerBusinessId === actor.businessId ? "seller" : null;
}

/** The PO of an order, for a participant. Null when there is none (or the viewer is not a party). */
export async function getPurchaseOrderForOrder(actor: Actor, orderId: string, now: Date = new Date()): Promise<PurchaseOrderView | null> {
  if (!UUID.test(orderId)) return null;
  const po = await prisma.purchaseOrder.findUnique({ where: { orderId }, include: INCLUDE });
  const role = po ? roleOf(po, actor) : null;
  return po && role ? buildView(po, role, now) : null;
}

export async function getPurchaseOrder(actor: Actor, id: string, now: Date = new Date()): Promise<PurchaseOrderView | null> {
  if (!UUID.test(id)) return null;
  const po = await prisma.purchaseOrder.findUnique({ where: { id }, include: INCLUDE });
  const role = po ? roleOf(po, actor) : null;
  return po && role ? buildView(po, role, now) : null;
}

/** Cheap summary for order lists/pages: the PO number, status and the next due date, without loading all versions. */
export async function purchaseOrderSummaries(actor: Actor, orderIds: string[]): Promise<Map<string, { number: string; status: PurchaseOrderView["status"] }>> {
  const ids = orderIds.filter((i) => UUID.test(i));
  if (!ids.length) return new Map();
  const rows = await prisma.purchaseOrder.findMany({ where: { orderId: { in: ids }, OR: [{ buyerBusinessId: actor.businessId }, { sellerBusinessId: actor.businessId }] }, select: { orderId: true, number: true, status: true } });
  return new Map(rows.map((r) => [r.orderId, { number: r.number, status: r.status }]));
}

// ---- issuing and amending ------------------------------------------------------------------------------------------------------

export interface PoDraftInput {
  /** a saved delivery address of the buyer (identity.listAddresses) */
  addressId?: string | null;
  paymentTermsDays?: number | null;
  /** "YYYY-MM-DD" */
  expectedDelivery?: string | null;
  notes?: string | null;
  /** omit to derive one line from the order (single quote line); give N lines for a multi-line order */
  lines?: PoLineInput[] | null;
  /** used for the derived line */
  gstRateBps?: number | null;
  hsn?: string | null;
}

async function nextPoNumber(tx: Tx, buyerBusinessId: string, fy: string): Promise<string> {
  // The upsert row-locks the (buyer, FY) counter until the issuing transaction ends: a rollback releases the number (no gaps)
  // and concurrent issuers serialise.
  const rows = await tx.$queryRaw<{ last_number: number }[]>`
    INSERT INTO purchase_order_sequences (buyer_business_id, financial_year, last_number) VALUES (${buyerBusinessId}::uuid, ${fy}, 1)
    ON CONFLICT (buyer_business_id, financial_year) DO UPDATE SET last_number = purchase_order_sequences.last_number + 1
    RETURNING last_number`;
  return formatPoNumber(fy, rows[0]!.last_number);
}

const clean = (v: string | null | undefined, max: number, field: string): string | null => {
  const s = v?.trim();
  if (!s) return null;
  if (s.length > max) throw new DomainError("validation", `Keep this under ${max} characters.`, { [field]: `Keep this under ${max} characters.` });
  return s;
};

async function addressSnapshot(buyerBusinessId: string, addressId: string | null | undefined, fallback?: AddressSnapshot): Promise<AddressSnapshot> {
  if (!addressId) {
    if (fallback) return fallback;
    throw new DomainError("validation", "Choose a delivery address.", { addressId: "Choose a delivery address." });
  }
  const a = (await identity.listAddresses(buyerBusinessId)).find((x) => x.id === addressId);
  if (!a) throw new DomainError("validation", "Choose one of your saved addresses.", { addressId: "Choose one of your saved addresses." });
  return { label: a.label, contactName: a.contactName, phone: a.phone, line1: a.line1, line2: a.line2, city: a.city, state: a.state, stateCode: a.stateCode, pincode: a.pincode };
}

function checkTerms(days: number | null | undefined): number {
  if (days == null || !Number.isInteger(days) || days < 0 || days > MAX_PAYMENT_TERMS_DAYS) {
    throw new DomainError("validation", `Enter the payment terms in days (0 to ${MAX_PAYMENT_TERMS_DAYS}).`, { paymentTermsDays: "Enter the payment terms in days." });
  }
  return days;
}

function checkDelivery(d: string | null | undefined, today: string): string | null {
  if (!d) return null;
  if (!isIsoDate(d)) throw new DomainError("validation", "Enter a valid delivery date.", { expectedDelivery: "Enter a valid delivery date." });
  if (d < today) throw new DomainError("validation", "The expected delivery date cannot be in the past.", { expectedDelivery: "The expected delivery date cannot be in the past." });
  return d;
}

function assertBuyer(order: Pick<Order, "buyerBusinessId" | "status" | "settlement">, actor: Actor): void {
  if (order.buyerBusinessId !== actor.businessId) throw new DomainError("not_found", "Order not found");
}

interface Persisted { po: PurchaseOrder; version: PurchaseOrderVersion; lines: PoLine[]; totals: PoTotals; buyer: PartySnapshot; seller: PartySnapshot; address: AddressSnapshot; intra: boolean; pos: string }

async function storePdf(p: Persisted): Promise<void> {
  const bytes = await renderPurchaseOrderPdf({
    number: p.po.number, version: p.version.version, issuedAt: p.version.createdAt, buyer: p.buyer, seller: p.seller, deliveryAddress: p.address, placeOfSupply: p.pos, intraState: p.intra,
    paymentTermsDays: p.version.paymentTermsDays, expectedDelivery: p.version.expectedDelivery ? fromDbDate(p.version.expectedDelivery) : null, notes: p.version.notes, lines: p.lines, totals: p.totals,
  });
  const key = `invoices/po/${p.po.id}/v${p.version.version}.pdf`;
  await getMediaStore("private").put(key, bytes, "application/pdf");
  // The only write a version ever receives: its PDF key + hash, set once (guarded by pdfKey: null).
  await prisma.purchaseOrderVersion.updateMany({ where: { id: p.version.id, pdfKey: null }, data: { pdfKey: key, pdfSha256: createHash("sha256").update(bytes).digest("hex") } });
}

/** PDF failures must not fail the issue: the version is the source of truth and getPurchaseOrderPdf renders on demand. */
async function storePdfSafe(p: Persisted): Promise<void> {
  try { await storePdf(p); } catch (e) { console.error("[enquiry] purchase order PDF could not be stored", e); }
}

export interface PoSuggestion {
  /** from the quote's payment terms when they name a number of days */
  paymentTermsDays: number | null;
  /** today + the quote's lead time, when known */
  expectedDelivery: string | null;
  gstPercent: number;
  /** the line that will be created from the order */
  line: { description: string; quantity: number; unit: string; unitPricePaise: number; priceIncludesGst: boolean } | null;
}

/** Form defaults for issuing a PO for an order, derived from the order and its quote. Null when the actor is not the buyer. */
export async function suggestPurchaseOrder(actor: Actor, orderId: string, now: Date = new Date()): Promise<PoSuggestion | null> {
  if (!UUID.test(orderId)) return null;
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.buyerBusinessId !== actor.businessId) return null;
  const [quote, enquiry] = await Promise.all([
    order.quoteId ? prisma.quote.findUnique({ where: { id: order.quoteId } }) : Promise.resolve(null),
    order.enquiryId ? prisma.enquiry.findUnique({ where: { id: order.enquiryId }, select: { title: true } }) : Promise.resolve(null),
  ]);
  return {
    paymentTermsDays: paymentTermsToDays(quote?.paymentTerms),
    expectedDelivery: quote?.leadTimeDays != null ? addDays(istDate(now), quote.leadTimeDays) : null,
    gstPercent: defaultPoGstRateBps() / 100,
    line: order.quantity !== null && order.pricePaise !== null && order.unit
      ? { description: enquiry?.title ?? "Goods as per order", quantity: order.quantity, unit: order.unit, unitPricePaise: Number(order.pricePaise), priceIncludesGst: quote?.gstIncluded ?? false }
      : null,
  };
}

/**
 * Buyer issues the PO for an order. Lines default to the order's single quote line; pass `lines` for several. The PO number is
 * consumed only if the transaction commits. One PO per order: use amendPurchaseOrder to change it.
 */
export async function issuePurchaseOrder(actor: Actor, orderId: string, input: PoDraftInput, now: Date = new Date()): Promise<PurchaseOrderView> {
  assertPurchaseOrdersEnabled();
  if (!UUID.test(orderId)) throw new DomainError("not_found", "Order not found");
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new DomainError("not_found", "Order not found");
  assertBuyer(order, actor);
  if (order.status === "cancelled") throw new DomainError("conflict", "This order was cancelled.");
  if (order.settlement === "ondc") throw new DomainError("conflict", "Network (ONDC) orders carry their own order document.");
  const [quote, enquiry, parties, address] = await Promise.all([
    order.quoteId ? prisma.quote.findUnique({ where: { id: order.quoteId } }) : Promise.resolve(null),
    order.enquiryId ? prisma.enquiry.findUnique({ where: { id: order.enquiryId }, select: { title: true } }) : Promise.resolve(null),
    identity.getPartyProfiles([order.buyerBusinessId, order.sellerBusinessId]),
    addressSnapshot(order.buyerBusinessId, input.addressId),
  ]);
  const today = istDate(now);
  let lineInputs = input.lines ?? null;
  if (!lineInputs || lineInputs.length === 0) {
    if (order.quantity === null || order.pricePaise === null || !order.unit) {
      throw new DomainError("validation", "This order has no quantity and price yet. Add the lines of the purchase order.", { lines: "Add at least one line." });
    }
    lineInputs = [{
      description: enquiry?.title ?? "Goods as per order", hsn: input.hsn ?? null, quantity: order.quantity, unit: order.unit, unitPricePaise: Number(order.pricePaise),
      gstRateBps: input.gstRateBps ?? defaultPoGstRateBps(), priceIncludesGst: quote?.gstIncluded ?? false, quoteId: order.quoteId,
    }];
  }
  const terms = checkTerms(input.paymentTermsDays ?? paymentTermsToDays(quote?.paymentTerms));
  const delivery = checkDelivery(input.expectedDelivery ?? (quote?.leadTimeDays != null ? addDays(today, quote.leadTimeDays) : null), today);
  const buyerP = parties.get(order.buyerBusinessId);
  const sellerP = parties.get(order.sellerBusinessId);
  if (!buyerP || !sellerP) throw new DomainError("not_found", "Order not found");
  const buyer: PartySnapshot = { name: buyerP.name, legalName: buyerP.legalName, gstin: buyerP.gstin, stateCode: buyerP.stateCode };
  const seller: PartySnapshot = { name: sellerP.name, legalName: sellerP.legalName, gstin: sellerP.gstin, stateCode: sellerP.stateCode };
  const intra = isIntraState(address.stateCode, seller.stateCode);
  const calc = computePo(lineInputs, intra);
  const notes = clean(input.notes, 1000, "notes");

  const persisted = await prisma.$transaction(async (tx): Promise<Persisted> => {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
    const fresh = await tx.order.findUnique({ where: { id: orderId }, select: { status: true, purchaseOrder: { select: { id: true } } } });
    if (!fresh || fresh.status === "cancelled") throw new DomainError("conflict", "This order was cancelled.");
    if (fresh.purchaseOrder) throw new DomainError("conflict", "A purchase order already exists for this order. Amend it instead.");
    const fy = financialYear(now);
    const number = await nextPoNumber(tx, order.buyerBusinessId, fy);
    const po = await tx.purchaseOrder.create({ data: { orderId, buyerBusinessId: order.buyerBusinessId, sellerBusinessId: order.sellerBusinessId, number, financialYear: fy } });
    const version = await tx.purchaseOrderVersion.create({
      data: {
        purchaseOrderId: po.id, version: 1, paymentTermsDays: terms, expectedDelivery: delivery ? toDbDate(delivery) : null, buyer: buyer as object, seller: seller as object,
        deliveryAddress: address as object, placeOfSupply: address.stateCode, intraState: intra, taxablePaise: BigInt(calc.totals.taxablePaise), cgstPaise: BigInt(calc.totals.cgstPaise),
        sgstPaise: BigInt(calc.totals.sgstPaise), igstPaise: BigInt(calc.totals.igstPaise), totalPaise: BigInt(calc.totals.totalPaise), notes, createdByPersonId: actor.personId,
        lines: { create: calc.lines.map((l) => ({ lineNo: l.lineNo, description: l.description, hsn: l.hsn, quantity: l.quantity, unit: l.unit, unitPricePaise: BigInt(l.unitPricePaise), priceIncludesGst: l.priceIncludesGst, gstRateBps: l.gstRateBps, taxablePaise: BigInt(l.taxablePaise), taxPaise: BigInt(l.taxPaise), totalPaise: BigInt(l.totalPaise), quoteId: l.quoteId })) },
      },
    });
    await emit(tx, "PurchaseOrderIssued", { type: "purchase_order", id: po.id }, {
      purchaseOrderId: po.id, orderId, number, version: 1, buyerBusinessId: po.buyerBusinessId, sellerBusinessId: po.sellerBusinessId, totalPaise: calc.totals.totalPaise, paymentTermsDays: terms,
    });
    return { po, version, lines: calc.lines, totals: calc.totals, buyer, seller, address, intra, pos: address.stateCode };
  });
  await storePdfSafe(persisted);
  return (await getPurchaseOrder(actor, persisted.po.id, now))!;
}

/**
 * Buyer amends the PO: a NEW version is created from the previous one plus the changes; earlier versions stay as sent. The seller
 * must acknowledge the new version again. The new total may not drop below what the seller already invoiced.
 */
export async function amendPurchaseOrder(actor: Actor, purchaseOrderId: string, input: PoDraftInput, now: Date = new Date()): Promise<PurchaseOrderView> {
  assertPurchaseOrdersEnabled();
  if (!UUID.test(purchaseOrderId)) throw new DomainError("not_found", "Purchase order not found");
  const today = istDate(now);
  const head = await prisma.purchaseOrder.findUnique({ where: { id: purchaseOrderId }, include: { versions: { include: { lines: true }, orderBy: { version: "desc" }, take: 1 } } });
  if (!head || head.buyerBusinessId !== actor.businessId) throw new DomainError("not_found", "Purchase order not found");
  const prev = head.versions[0]!;
  const prevAddress = prev.deliveryAddress as unknown as AddressSnapshot;
  const address = input.addressId ? await addressSnapshot(head.buyerBusinessId, input.addressId) : prevAddress;
  const lineInputs: PoLineInput[] = input.lines?.length
    ? input.lines
    : [...prev.lines].sort((a, b) => a.lineNo - b.lineNo).map((l) => ({ description: l.description, hsn: l.hsn, quantity: l.quantity, unit: l.unit, unitPricePaise: Number(l.unitPricePaise), gstRateBps: l.gstRateBps, priceIncludesGst: l.priceIncludesGst, quoteId: l.quoteId }));
  const buyer = prev.buyer as unknown as PartySnapshot;
  const seller = prev.seller as unknown as PartySnapshot;
  const intra = isIntraState(address.stateCode, seller.stateCode);
  const calc = computePo(lineInputs, intra);
  const terms = input.paymentTermsDays == null ? prev.paymentTermsDays : checkTerms(input.paymentTermsDays);
  const delivery = input.expectedDelivery === undefined ? (prev.expectedDelivery ? fromDbDate(prev.expectedDelivery) : null) : checkDelivery(input.expectedDelivery, today);
  const notes = input.notes === undefined ? prev.notes : clean(input.notes, 1000, "notes");

  const persisted = await prisma.$transaction(async (tx): Promise<Persisted> => {
    await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${purchaseOrderId}::uuid FOR UPDATE`;
    const po = await tx.purchaseOrder.findUnique({ where: { id: purchaseOrderId } });
    if (!po) throw new DomainError("not_found", "Purchase order not found");
    if (po.status === "cancelled") throw new DomainError("conflict", "This purchase order was cancelled.");
    if (po.currentVersion !== prev.version) throw new DomainError("conflict", "The purchase order changed while you were editing. Reload and try again.");
    const same = prev.paymentTermsDays === terms && (prev.expectedDelivery ? fromDbDate(prev.expectedDelivery) : null) === delivery && (prev.notes ?? null) === (notes ?? null)
      && JSON.stringify(prevAddress) === JSON.stringify(address) && prev.totalPaise === BigInt(calc.totals.totalPaise) && JSON.stringify(sig(calc.lines)) === JSON.stringify(sig([...prev.lines].sort((a, b) => a.lineNo - b.lineNo).map((l) => ({ ...lineView(l) }))));
    if (same) throw new DomainError("validation", "Nothing changed. Edit at least one field to issue a new version.");
    const invoiced = await tx.supplierInvoice.aggregate({ where: { purchaseOrderId, status: { not: "void" } }, _sum: { totalPaise: true } });
    if ((invoiced._sum.totalPaise ?? 0n) > BigInt(calc.totals.totalPaise)) throw new DomainError("validation", "The new total is below what the seller has already invoiced.", { lines: "Below the invoiced amount." });
    const n = po.currentVersion + 1;
    const version = await tx.purchaseOrderVersion.create({
      data: {
        purchaseOrderId, version: n, paymentTermsDays: terms, expectedDelivery: delivery ? toDbDate(delivery) : null, buyer: buyer as object, seller: seller as object,
        deliveryAddress: address as object, placeOfSupply: address.stateCode, intraState: intra, taxablePaise: BigInt(calc.totals.taxablePaise), cgstPaise: BigInt(calc.totals.cgstPaise),
        sgstPaise: BigInt(calc.totals.sgstPaise), igstPaise: BigInt(calc.totals.igstPaise), totalPaise: BigInt(calc.totals.totalPaise), notes, createdByPersonId: actor.personId,
        lines: { create: calc.lines.map((l) => ({ lineNo: l.lineNo, description: l.description, hsn: l.hsn, quantity: l.quantity, unit: l.unit, unitPricePaise: BigInt(l.unitPricePaise), priceIncludesGst: l.priceIncludesGst, gstRateBps: l.gstRateBps, taxablePaise: BigInt(l.taxablePaise), taxPaise: BigInt(l.taxPaise), totalPaise: BigInt(l.totalPaise), quoteId: l.quoteId })) },
      },
    });
    const updated = await tx.purchaseOrder.update({ where: { id: purchaseOrderId }, data: { currentVersion: n, status: "issued" } });
    await emit(tx, "PurchaseOrderAmended", { type: "purchase_order", id: po.id }, {
      purchaseOrderId, orderId: po.orderId, number: po.number, version: n, previousVersion: po.currentVersion, buyerBusinessId: po.buyerBusinessId, sellerBusinessId: po.sellerBusinessId, totalPaise: calc.totals.totalPaise, paymentTermsDays: terms,
    });
    return { po: updated, version, lines: calc.lines, totals: calc.totals, buyer, seller, address, intra, pos: address.stateCode };
  });
  await storePdfSafe(persisted);
  return (await getPurchaseOrder(actor, purchaseOrderId, now))!;
}

const sig = (ls: { description: string; hsn: string | null; quantity: number; unit: string; unitPricePaise: number; gstRateBps: number; priceIncludesGst: boolean }[]) =>
  ls.map((l) => [l.description, l.hsn, l.quantity, l.unit, l.unitPricePaise, l.gstRateBps, l.priceIncludesGst]);

// ---- seller answer and cancellation ------------------------------------------------------------------------------------------

/** Seller accepts or rejects the CURRENT version. Accepting is the written agreement that sets the s.43B(h) payment period. */
export async function acknowledgePurchaseOrder(actor: Actor, purchaseOrderId: string, input: { decision: "accepted" | "rejected"; reason?: string | null }): Promise<PurchaseOrderView> {
  assertPurchaseOrdersEnabled();
  if (!UUID.test(purchaseOrderId)) throw new DomainError("not_found", "Purchase order not found");
  if (input.decision !== "accepted" && input.decision !== "rejected") throw new DomainError("validation", "Choose accept or reject.");
  const reason = clean(input.reason, 500, "reason");
  if (input.decision === "rejected" && (!reason || reason.length < 3)) throw new DomainError("validation", "Say why you are rejecting this purchase order.", { reason: "Say why you are rejecting it." });
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${purchaseOrderId}::uuid FOR UPDATE`;
    const po = await tx.purchaseOrder.findUnique({ where: { id: purchaseOrderId } });
    if (!po || po.sellerBusinessId !== actor.businessId) throw new DomainError("not_found", "Purchase order not found");
    if (po.status !== "issued") throw new DomainError("conflict", po.status === "cancelled" ? "This purchase order was cancelled." : "You already answered this version of the purchase order.");
    const ver = await tx.purchaseOrderVersion.findUnique({ where: { purchaseOrderId_version: { purchaseOrderId, version: po.currentVersion } } });
    if (!ver) throw new DomainError("not_found", "Purchase order not found");
    await tx.purchaseOrderAck.create({ data: { versionId: ver.id, decision: input.decision, reason, byPersonId: actor.personId } });
    await tx.purchaseOrder.update({ where: { id: purchaseOrderId }, data: { status: input.decision === "accepted" ? "acknowledged" : "rejected" } });
    await emit(tx, "PurchaseOrderAcknowledged", { type: "purchase_order", id: purchaseOrderId }, {
      purchaseOrderId, orderId: po.orderId, number: po.number, version: po.currentVersion, buyerBusinessId: po.buyerBusinessId, sellerBusinessId: po.sellerBusinessId, decision: input.decision, reason,
    });
  });
  return (await getPurchaseOrder(actor, purchaseOrderId))!;
}

/** Buyer cancels the PO. Not possible once the seller has a live (non-withdrawn) invoice against it. */
export async function cancelPurchaseOrder(actor: Actor, purchaseOrderId: string, reason: string): Promise<PurchaseOrderView> {
  assertPurchaseOrdersEnabled();
  if (!UUID.test(purchaseOrderId)) throw new DomainError("not_found", "Purchase order not found");
  const why = clean(reason, 300, "reason");
  if (!why || why.length < 3) throw new DomainError("validation", "Give a reason for cancelling.", { reason: "Give a reason for cancelling." });
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${purchaseOrderId}::uuid FOR UPDATE`;
    const po = await tx.purchaseOrder.findUnique({ where: { id: purchaseOrderId } });
    if (!po || po.buyerBusinessId !== actor.businessId) throw new DomainError("not_found", "Purchase order not found");
    if (po.status === "cancelled") throw new DomainError("conflict", "This purchase order is already cancelled.");
    const live = await tx.supplierInvoice.count({ where: { purchaseOrderId, status: { not: "void" } } });
    if (live > 0) throw new DomainError("conflict", "The seller has already invoiced against this purchase order, so it cannot be cancelled.");
    await cancelTx(tx, po, actor.businessId, why);
  });
  return (await getPurchaseOrder(actor, purchaseOrderId))!;
}

async function cancelTx(tx: Tx, po: PurchaseOrder, byBusinessId: string, reason: string): Promise<void> {
  await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: "cancelled", cancelledAt: new Date(), cancelledByBusinessId: byBusinessId, cancelReason: reason } });
  await emit(tx, "PurchaseOrderCancelled", { type: "purchase_order", id: po.id }, {
    purchaseOrderId: po.id, orderId: po.orderId, number: po.number, buyerBusinessId: po.buyerBusinessId, sellerBusinessId: po.sellerBusinessId, cancelledByBusinessId: byBusinessId, reason,
  });
}

/** Order cancelled: the PO is cancelled with it and unpaid invoices are withdrawn (called inside the order transaction). */
export async function onOrderCancelledTx(tx: Tx, orderId: string, byBusinessId: string): Promise<void> {
  const po = await tx.purchaseOrder.findUnique({ where: { orderId } });
  if (!po) return;
  await voidOpenInvoicesForOrderTx(tx, orderId, "order cancelled");
  if (po.status !== "cancelled") await cancelTx(tx, po, byBusinessId, "order cancelled");
}

// ---- PDF -----------------------------------------------------------------------------------------------------------------------

/** The stored PDF of a version (default: current), for a participant. Renders and stores it on demand when issuing could not. */
export async function getPurchaseOrderPdf(actor: Actor, purchaseOrderId: string, version?: number): Promise<{ bytes: Uint8Array; filename: string }> {
  if (!UUID.test(purchaseOrderId)) throw new DomainError("not_found", "Purchase order not found");
  const po = await prisma.purchaseOrder.findUnique({ where: { id: purchaseOrderId }, include: { versions: { include: { lines: true } } } });
  if (!po || !roleOf(po, actor)) throw new DomainError("not_found", "Purchase order not found");
  const v = po.versions.find((x) => x.version === (version ?? po.currentVersion));
  if (!v) throw new DomainError("not_found", "Purchase order not found");
  const filename = `${po.number.replace(/\//g, "-")}-v${v.version}.pdf`;
  const store = getMediaStore("private");
  if (v.pdfKey) {
    const hit = await store.get(v.pdfKey).catch(() => null);
    if (hit) return { bytes: hit.bytes, filename };
  }
  const lines = [...v.lines].sort((a, b) => a.lineNo - b.lineNo).map((l) => ({ ...lineView(l) }));
  const p: Persisted = {
    po, version: v, lines, totals: { taxablePaise: Number(v.taxablePaise), cgstPaise: Number(v.cgstPaise), sgstPaise: Number(v.sgstPaise), igstPaise: Number(v.igstPaise), taxPaise: Number(v.cgstPaise + v.sgstPaise + v.igstPaise), totalPaise: Number(v.totalPaise) },
    buyer: v.buyer as unknown as PartySnapshot, seller: v.seller as unknown as PartySnapshot, address: v.deliveryAddress as unknown as AddressSnapshot, intra: v.intraState, pos: v.placeOfSupply,
  };
  await storePdfSafe(p);
  const again = await prisma.purchaseOrderVersion.findUnique({ where: { id: v.id }, select: { pdfKey: true } });
  const stored = again?.pdfKey ? await store.get(again.pdfKey).catch(() => null) : null;
  if (stored) return { bytes: stored.bytes, filename };
  const bytes = await renderPurchaseOrderPdf({
    number: po.number, version: v.version, issuedAt: v.createdAt, buyer: p.buyer, seller: p.seller, deliveryAddress: p.address, placeOfSupply: p.pos, intraState: p.intra,
    paymentTermsDays: v.paymentTermsDays, expectedDelivery: v.expectedDelivery ? fromDbDate(v.expectedDelivery) : null, notes: v.notes, lines: p.lines, totals: p.totals,
  });
  return { bytes, filename };
}

/** System read for notifiers: the two businesses and number of a PO. */
export async function getPurchaseOrderParties(purchaseOrderId: string): Promise<{ number: string; orderId: string; buyerBusinessId: string; sellerBusinessId: string } | null> {
  if (!UUID.test(purchaseOrderId)) return null;
  return prisma.purchaseOrder.findUnique({ where: { id: purchaseOrderId }, select: { number: true, orderId: true, buyerBusinessId: true, sellerBusinessId: true } });
}
