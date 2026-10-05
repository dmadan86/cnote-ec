// Returns (RMA): the buyer raises a return from a goods receipt (rejected units, or accepted units within the return window); the seller approves or
// rejects; the buyer records the return shipment; the seller confirms receipt and records a credit note that reduces the invoice payable. A rejected
// return can be taken to a dispute (@cnote/disputes owns disputes; this module only stores the link). With escrow funds held, the credit note event
// makes @cnote/escrow refund up to the credited amount. docs/design/grn-returns.md.
import { financialYear } from "@cnote/billing";
import { DomainError, emit } from "@cnote/core";
import { prisma, type GoodsReturn, type GoodsReturnLine, type Prisma, type ReturnCreditNote } from "@cnote/db";
import { nextDocNumber } from "./goods-receipts";
import {
  assertReturnAction, canReturnAct, checkCreditAmounts, isReturnReason, LIVE_RETURN_STATUSES, normaliseCreditNoteNumber, returnableQty, returnDeadline, returnWindowDays, returnWindowOpen,
  type ReturnAction, type ReturnLineInput, type ReturnReason, type ReturnSource, type ReturnStatus,
} from "./grn-core";
import { fromDbDate, isIsoDate, istDate, normaliseIrn, toDbDate } from "./po-core";
import { assertPurchaseOrdersEnabled } from "./supplier-invoices";
import { profiles } from "./support";
import type { Actor } from "./types";

const UUID = /^[0-9a-f-]{36}$/i;
const PAGE = 20;

// ---- views -----------------------------------------------------------------------------------------------------------------------

export interface ReturnLineView { id: string; receiptLineId: string; poLineNo: number; description: string; unit: string; quantity: number; source: ReturnSource; unitPricePaise: number }

export interface CreditNoteView {
  id: string;
  invoiceId: string;
  number: string;
  noteDate: string;
  taxablePaise: number;
  gstPaise: number;
  totalPaise: number;
  irn: string | null;
  createdAt: string;
}

export interface GoodsReturnView {
  id: string;
  number: string;
  role: "buyer" | "seller";
  status: ReturnStatus;
  receiptId: string;
  receiptNumber: string;
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  orderId: string;
  buyerName: string;
  sellerName: string;
  reasonCode: ReturnReason;
  reasonNote: string | null;
  estimatedPaise: number;
  units: number;
  lines: ReturnLineView[];
  decidedAt: string | null;
  decisionNote: string | null;
  shipment: { courier: string | null; trackingRef: string; shippedAt: string } | null;
  receivedBackAt: string | null;
  creditNote: CreditNoteView | null;
  disputeId: string | null;
  createdAt: string;
  actions: Record<ReturnAction, boolean>;
}

type ReturnRow = GoodsReturn & { lines: GoodsReturnLine[]; creditNote: ReturnCreditNote | null; receipt: { number: string }; };

const ALL_ACTIONS: ReturnAction[] = ["cancel", "approve", "reject", "ship", "receive", "credit", "dispute"];

async function toViews(rows: ReturnRow[], actor: Actor): Promise<GoodsReturnView[]> {
  if (!rows.length) return [];
  const [profs, pos] = await Promise.all([
    profiles(rows.flatMap((r) => [r.buyerBusinessId, r.sellerBusinessId])),
    prisma.purchaseOrder.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.purchaseOrderId))] } }, select: { id: true, number: true } }),
  ]);
  const poNo = new Map(pos.map((p) => [p.id, p.number]));
  return rows.map((r) => {
    const role = r.buyerBusinessId === actor.businessId ? "buyer" : "seller";
    const status = r.status as ReturnStatus;
    return {
      id: r.id, number: r.number, role, status, receiptId: r.receiptId, receiptNumber: r.receipt.number, purchaseOrderId: r.purchaseOrderId, purchaseOrderNumber: poNo.get(r.purchaseOrderId) ?? "",
      orderId: r.orderId, buyerName: profs.get(r.buyerBusinessId)?.name ?? "Buyer", sellerName: profs.get(r.sellerBusinessId)?.name ?? "Seller",
      reasonCode: r.reasonCode as ReturnReason, reasonNote: r.reasonNote, estimatedPaise: Number(r.estimatedPaise), units: r.lines.reduce((s, l) => s + l.quantity, 0),
      lines: [...r.lines].sort((a, b) => a.poLineNo - b.poLineNo).map((l) => ({ id: l.id, receiptLineId: l.receiptLineId, poLineNo: l.poLineNo, description: l.description, unit: l.unit, quantity: l.quantity, source: l.source as ReturnSource, unitPricePaise: Number(l.unitPricePaise) })),
      decidedAt: r.decidedAt?.toISOString() ?? null, decisionNote: r.decisionNote,
      shipment: r.shipTrackingRef && r.shippedAt ? { courier: r.shipCourier, trackingRef: r.shipTrackingRef, shippedAt: r.shippedAt.toISOString() } : null,
      receivedBackAt: r.receivedBackAt?.toISOString() ?? null,
      creditNote: r.creditNote ? creditView(r.creditNote) : null,
      disputeId: r.disputeId, createdAt: r.createdAt.toISOString(),
      actions: Object.fromEntries(ALL_ACTIONS.map((a) => [a, canReturnAct(status, a, role) && (a !== "dispute" || !r.disputeId)])) as Record<ReturnAction, boolean>,
    };
  });
}

const creditView = (c: ReturnCreditNote): CreditNoteView => ({
  id: c.id, invoiceId: c.invoiceId, number: c.number, noteDate: fromDbDate(c.noteDate), taxablePaise: Number(c.taxablePaise), gstPaise: Number(c.gstPaise), totalPaise: Number(c.totalPaise),
  irn: c.irn, createdAt: c.createdAt.toISOString(),
});

const INCLUDE = { lines: true, creditNote: true, receipt: { select: { number: true } } } satisfies Prisma.GoodsReturnInclude;

function roleOf(r: Pick<GoodsReturn, "buyerBusinessId" | "sellerBusinessId">, actor: Actor): "buyer" | "seller" | null {
  return r.buyerBusinessId === actor.businessId ? "buyer" : r.sellerBusinessId === actor.businessId ? "seller" : null;
}

export async function getGoodsReturn(actor: Actor, id: string): Promise<GoodsReturnView | null> {
  if (!UUID.test(id)) return null;
  const r = await prisma.goodsReturn.findUnique({ where: { id }, include: INCLUDE });
  if (!r || !roleOf(r, actor)) return null;
  return (await toViews([r], actor))[0]!;
}

export interface ReturnsPage { items: GoodsReturnView[]; nextCursor: string | null; counts: { open: number; actionNeeded: number } }

/** Returns of the actor's business as buyer or seller, newest first. `status: "open"` = not yet credited, rejected or cancelled. */
export async function listGoodsReturns(actor: Actor, opts: { role: "buyer" | "seller"; status?: ReturnStatus | "open" | null; cursor?: string | null }): Promise<ReturnsPage> {
  const own: Prisma.GoodsReturnWhereInput = opts.role === "buyer" ? { buyerBusinessId: actor.businessId } : { sellerBusinessId: actor.businessId };
  const statusWhere: Prisma.GoodsReturnWhereInput = opts.status === "open" ? { status: { in: ["requested", "approved", "shipped", "received"] } } : opts.status ? { status: opts.status } : {};
  const cursor = opts.cursor && UUID.test(opts.cursor) ? { id: opts.cursor } : undefined;
  const [rows, open, actionNeeded] = await Promise.all([
    prisma.goodsReturn.findMany({ where: { ...own, ...statusWhere }, include: INCLUDE, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: PAGE + 1, ...(cursor ? { cursor, skip: 1 } : {}) }),
    prisma.goodsReturn.count({ where: { ...own, status: { in: ["requested", "approved", "shipped", "received"] } } }),
    // what is waiting for this side: the seller answers requests and credits; the buyer ships approved returns
    prisma.goodsReturn.count({ where: { ...own, status: opts.role === "seller" ? { in: ["requested", "approved", "shipped", "received"] } : "approved" } }),
  ]);
  const page = rows.slice(0, PAGE);
  return { items: await toViews(page, actor), nextCursor: rows.length > PAGE ? page[page.length - 1]!.id : null, counts: { open, actionNeeded } };
}

export async function listReturnsForOrder(actor: Actor, orderId: string): Promise<GoodsReturnView[]> {
  if (!UUID.test(orderId)) return [];
  const rows = await prisma.goodsReturn.findMany({
    where: { orderId, OR: [{ buyerBusinessId: actor.businessId }, { sellerBusinessId: actor.businessId }] }, include: INCLUDE, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return toViews(rows, actor);
}

// ---- what can still be returned (the form's source of truth) ---------------------------------------------------------------------------

export interface ReturnableLine {
  receiptLineId: string;
  poLineNo: number;
  description: string;
  unit: string;
  unitPricePaise: number;
  rejectedReturnable: number;
  acceptedReturnable: number;
}
export interface ReturnableView { receiptId: string; receiptNumber: string; purchaseOrderId: string; windowOpen: boolean; deadline: string; lines: ReturnableLine[] }

async function alreadyReturned(db: Pick<typeof prisma, "goodsReturnLine">, receiptLineIds: string[]): Promise<Map<string, number>> {
  if (!receiptLineIds.length) return new Map();
  const rows = await db.goodsReturnLine.groupBy({
    by: ["receiptLineId", "source"], where: { receiptLineId: { in: receiptLineIds }, goodsReturn: { status: { in: LIVE_RETURN_STATUSES as ReturnStatus[] } } }, _sum: { quantity: true },
  });
  return new Map(rows.map((r) => [`${r.receiptLineId}:${r.source}`, r._sum.quantity ?? 0]));
}

export async function getReturnableLines(actor: Actor, receiptId: string, now: Date = new Date()): Promise<ReturnableView | null> {
  if (!UUID.test(receiptId)) return null;
  const r = await prisma.goodsReceipt.findUnique({ where: { id: receiptId }, include: { lines: true } });
  if (!r || r.buyerBusinessId !== actor.businessId) return null;
  const used = await alreadyReturned(prisma, r.lines.map((l) => l.id));
  const received = fromDbDate(r.receivedOn);
  const w = returnWindowDays();
  return {
    receiptId: r.id, receiptNumber: r.number, purchaseOrderId: r.purchaseOrderId, windowOpen: returnWindowOpen(received, istDate(now), w), deadline: returnDeadline(received, w),
    lines: [...r.lines].sort((a, b) => a.poLineNo - b.poLineNo).map((l) => ({
      receiptLineId: l.id, poLineNo: l.poLineNo, description: l.description, unit: l.unit, unitPricePaise: Number(l.unitPricePaise),
      rejectedReturnable: returnableQty(l, "rejected", used.get(`${l.id}:rejected`) ?? 0), acceptedReturnable: returnableQty(l, "accepted", used.get(`${l.id}:accepted`) ?? 0),
    })),
  };
}

// ---- requesting ----------------------------------------------------------------------------------------------------------------

export interface RequestReturnInput { receiptId: string; reasonCode: string; note?: string | null; lines: ReturnLineInput[] }

export async function requestReturn(actor: Actor, input: RequestReturnInput, now: Date = new Date()): Promise<GoodsReturnView> {
  assertPurchaseOrdersEnabled();
  if (!UUID.test(input.receiptId)) throw new DomainError("not_found", "Goods receipt not found");
  if (!isReturnReason(input.reasonCode)) throw new DomainError("validation", "Choose a reason for the return.", { reasonCode: "Choose a reason." });
  const note = input.note?.trim() || null;
  if (note && note.length > 500) throw new DomainError("validation", "Keep the note under 500 characters.", { note: "Keep this under 500 characters." });
  const wanted = (input.lines ?? []).filter((l) => l.quantity !== 0);
  if (!wanted.length) throw new DomainError("validation", "Choose at least one item to return.", { lines: "Choose what to return." });
  const keys = new Set<string>();
  for (const l of wanted) {
    if (!UUID.test(l.receiptLineId) || (l.source !== "rejected" && l.source !== "accepted")) throw new DomainError("validation", "Unknown receipt line.", { lines: "Unknown line." });
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 1) throw new DomainError("validation", "Return quantities must be whole numbers above 0.", { lines: "Enter a whole number above 0." });
    const k = `${l.receiptLineId}:${l.source}`;
    if (keys.has(k)) throw new DomainError("validation", "Each item can appear once per source.", { lines: "Duplicate line." });
    keys.add(k);
  }

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM goods_receipts WHERE id = ${input.receiptId}::uuid FOR UPDATE`;
    const receipt = await tx.goodsReceipt.findUnique({ where: { id: input.receiptId }, include: { lines: true } });
    if (!receipt || receipt.buyerBusinessId !== actor.businessId) throw new DomainError("not_found", "Goods receipt not found");
    const order = await tx.order.findUnique({ where: { id: receipt.orderId }, select: { status: true } });
    if (order?.status === "cancelled") throw new DomainError("conflict", "This order is cancelled.");
    const received = fromDbDate(receipt.receivedOn);
    const w = returnWindowDays();
    if (!returnWindowOpen(received, istDate(now), w)) {
      throw new DomainError("conflict", `The return window closed on ${returnDeadline(received, w)} (${w} days after receipt).`, { returnWindowClosed: true });
    }
    const byId = new Map(receipt.lines.map((l) => [l.id, l]));
    const used = await alreadyReturned(tx, receipt.lines.map((l) => l.id));
    let estimated = 0n;
    const create = wanted.map((w2) => {
      const line = byId.get(w2.receiptLineId);
      if (!line) throw new DomainError("validation", "That line is not on this receipt.", { lines: "Unknown line." });
      const room = returnableQty(line, w2.source, used.get(`${line.id}:${w2.source}`) ?? 0);
      if (w2.quantity > room) {
        throw new DomainError("validation", `Line ${line.poLineNo}: only ${room} ${line.unit} can still be returned from the ${w2.source} units.`, { lines: `Only ${room} can still be returned.` });
      }
      estimated += BigInt(w2.quantity) * line.unitPricePaise;
      return { receiptLineId: line.id, poLineNo: line.poLineNo, description: line.description, unit: line.unit, quantity: w2.quantity, source: w2.source, unitPricePaise: line.unitPricePaise };
    });
    const number = await nextDocNumber(tx, receipt.buyerBusinessId, "rma", financialYear(now));
    const row = await tx.goodsReturn.create({
      data: {
        number, financialYear: financialYear(now), receiptId: receipt.id, purchaseOrderId: receipt.purchaseOrderId, orderId: receipt.orderId, buyerBusinessId: receipt.buyerBusinessId,
        sellerBusinessId: receipt.sellerBusinessId, reasonCode: input.reasonCode, reasonNote: note, estimatedPaise: estimated, requestedByPersonId: actor.personId, lines: { create },
      },
      include: INCLUDE,
    });
    await emit(tx, "GoodsReturnRequested", { type: "goods_return", id: row.id }, {
      goodsReturnId: row.id, number, goodsReceiptId: receipt.id, purchaseOrderId: receipt.purchaseOrderId, orderId: receipt.orderId, buyerBusinessId: receipt.buyerBusinessId,
      sellerBusinessId: receipt.sellerBusinessId, units: create.reduce((s, l) => s + l.quantity, 0), estimatedPaise: Number(estimated), reasonCode: input.reasonCode,
    });
    return (await toViews([row], actor))[0]!;
  });
}

// ---- state changes -------------------------------------------------------------------------------------------------------------------

async function lockReturn(tx: Prisma.TransactionClient, actor: Actor, id: string, action: ReturnAction): Promise<GoodsReturn & { lines: GoodsReturnLine[] }> {
  if (!UUID.test(id)) throw new DomainError("not_found", "Return not found");
  await tx.$queryRaw`SELECT id FROM goods_returns WHERE id = ${id}::uuid FOR UPDATE`;
  const r = await tx.goodsReturn.findUnique({ where: { id }, include: { lines: true } });
  const role = r ? roleOf(r, actor) : null;
  if (!r || !role) throw new DomainError("not_found", "Return not found"); // non-participants: indistinguishable from missing
  assertReturnAction(r.status as ReturnStatus, action, role);
  return r;
}

const ids = (r: GoodsReturn) => ({ goodsReturnId: r.id, number: r.number, orderId: r.orderId, buyerBusinessId: r.buyerBusinessId, sellerBusinessId: r.sellerBusinessId });

async function reload(actor: Actor, id: string): Promise<GoodsReturnView> {
  return (await getGoodsReturn(actor, id))!;
}

/** Buyer withdraws a return the seller has not answered yet. */
export async function cancelReturn(actor: Actor, id: string): Promise<GoodsReturnView> {
  assertPurchaseOrdersEnabled();
  await prisma.$transaction(async (tx) => {
    const r = await lockReturn(tx, actor, id, "cancel");
    await tx.goodsReturn.update({ where: { id }, data: { status: "cancelled" } });
    await emit(tx, "GoodsReturnCancelled", { type: "goods_return", id }, ids(r));
  });
  return reload(actor, id);
}

/** Seller approves or rejects a requested return. A rejection needs a reason (the buyer sees it and may open a dispute). */
export async function decideReturn(actor: Actor, id: string, input: { decision: "approved" | "rejected"; note?: string | null }): Promise<GoodsReturnView> {
  assertPurchaseOrdersEnabled();
  const note = input.note?.trim() || null;
  if (input.decision === "rejected" && (!note || note.length < 3)) throw new DomainError("validation", "Give a reason for rejecting the return.", { note: "Give a reason." });
  if (note && note.length > 500) throw new DomainError("validation", "Keep the note under 500 characters.", { note: "Keep this under 500 characters." });
  await prisma.$transaction(async (tx) => {
    const r = await lockReturn(tx, actor, id, input.decision === "approved" ? "approve" : "reject");
    await tx.goodsReturn.update({ where: { id }, data: { status: input.decision, decidedAt: new Date(), decidedByPersonId: actor.personId, decisionNote: note } });
    await emit(tx, "GoodsReturnDecided", { type: "goods_return", id }, { ...ids(r), decision: input.decision });
  });
  return reload(actor, id);
}

/** Buyer records the return shipment (courier optional, tracking reference required). */
export async function recordReturnShipment(actor: Actor, id: string, input: { courier?: string | null; trackingRef: string }): Promise<GoodsReturnView> {
  assertPurchaseOrdersEnabled();
  const ref = input.trackingRef?.trim() ?? "";
  if (ref.length < 3 || ref.length > 40) throw new DomainError("validation", "Enter the tracking or LR number (3 to 40 characters).", { trackingRef: "Enter the tracking or LR number." });
  const courier = input.courier?.trim() || null;
  if (courier && courier.length > 60) throw new DomainError("validation", "Keep the courier name under 60 characters.", { courier: "Keep this under 60 characters." });
  await prisma.$transaction(async (tx) => {
    const r = await lockReturn(tx, actor, id, "ship");
    await tx.goodsReturn.update({ where: { id }, data: { status: "shipped", shipCourier: courier, shipTrackingRef: ref, shippedAt: new Date() } });
    await emit(tx, "GoodsReturnShipped", { type: "goods_return", id }, { ...ids(r), hasTrackingRef: true });
  });
  return reload(actor, id);
}

/** Seller confirms the returned goods are back. */
export async function confirmReturnReceived(actor: Actor, id: string): Promise<GoodsReturnView> {
  assertPurchaseOrdersEnabled();
  await prisma.$transaction(async (tx) => {
    const r = await lockReturn(tx, actor, id, "receive");
    await tx.goodsReturn.update({ where: { id }, data: { status: "received", receivedBackAt: new Date() } });
    await emit(tx, "GoodsReturnReceived", { type: "goods_return", id }, ids(r));
  });
  return reload(actor, id);
}

export interface CreditNoteInput {
  invoiceId: string;
  number: string;
  /** "YYYY-MM-DD" */
  noteDate: string;
  taxablePaise: number;
  gstPaise: number;
  /** optional e-invoice IRN of the credit note (64 hex) */
  irn?: string | null;
}

/**
 * Seller records the credit note for an approved return. It reduces the payable of the chosen invoice (outstanding = total - credited - paid);
 * an invoice that is fully covered by credit and payments becomes settled. When the buyer already paid more than the invoice is now worth, the
 * difference is shown as "refund due" (settled off-platform). `ReturnCreditNoteRecorded` lets @cnote/escrow refund held funds.
 */
export async function recordReturnCreditNote(actor: Actor, id: string, input: CreditNoteInput, now: Date = new Date()): Promise<GoodsReturnView> {
  assertPurchaseOrdersEnabled();
  const number = normaliseCreditNoteNumber(input.number);
  const total = checkCreditAmounts(input.taxablePaise, input.gstPaise);
  if (!isIsoDate(input.noteDate)) throw new DomainError("validation", "Enter a valid credit note date.", { noteDate: "Enter a valid date." });
  if (input.noteDate > istDate(now)) throw new DomainError("validation", "The credit note date cannot be in the future.", { noteDate: "The date cannot be in the future." });
  if (!UUID.test(input.invoiceId)) throw new DomainError("validation", "Choose the invoice this credit note is against.", { invoiceId: "Choose an invoice." });
  const irn = input.irn?.trim() ? normaliseIrn(input.irn) : null;
  await prisma.$transaction(async (tx) => {
    const r = await lockReturn(tx, actor, id, "credit");
    await tx.$queryRaw`SELECT id FROM supplier_invoices WHERE id = ${input.invoiceId}::uuid FOR UPDATE`;
    const inv = await tx.supplierInvoice.findUnique({ where: { id: input.invoiceId } });
    if (!inv || inv.sellerBusinessId !== actor.businessId || inv.purchaseOrderId !== r.purchaseOrderId) throw new DomainError("validation", "Choose one of your invoices on this purchase order.", { invoiceId: "Choose an invoice." });
    if (inv.status === "void") throw new DomainError("conflict", "That invoice was withdrawn.", { invoiceId: "Invoice withdrawn." });
    if (input.noteDate < fromDbDate(inv.invoiceDate)) throw new DomainError("validation", "The credit note cannot be dated before the invoice.", { noteDate: "Before the invoice date." });
    if (BigInt(total) > inv.totalPaise - inv.creditedPaise) throw new DomainError("validation", "The credit note is more than the invoice value that is not yet credited.", { taxable: "More than the invoice allows." });
    let cn: ReturnCreditNote;
    try {
      cn = await tx.returnCreditNote.create({
        data: {
          returnId: id, invoiceId: inv.id, orderId: r.orderId, buyerBusinessId: r.buyerBusinessId, sellerBusinessId: r.sellerBusinessId, number, financialYear: financialYear(toDbDate(input.noteDate)),
          noteDate: toDbDate(input.noteDate), taxablePaise: BigInt(input.taxablePaise), gstPaise: BigInt(input.gstPaise), totalPaise: BigInt(total), irn, recordedByPersonId: actor.personId,
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") {
        const target = JSON.stringify((e as { meta?: unknown }).meta ?? "");
        throw new DomainError("conflict", target.includes("irn") ? "This IRN is already recorded on another credit note." : "You already recorded a credit note with this number for this financial year.", target.includes("irn") ? { irn: "Already recorded." } : { number: "Already recorded." });
      }
      throw e;
    }
    const credited = inv.creditedPaise + BigInt(total);
    const settled = inv.status === "open" && inv.paidPaise + credited >= inv.totalPaise;
    await tx.supplierInvoice.update({ where: { id: inv.id }, data: { creditedPaise: credited, ...(settled ? { status: "paid", paidAt: now } : {}) } });
    await tx.goodsReturn.update({ where: { id }, data: { status: "credited", creditedAt: now } });
    const outstanding = inv.status === "open" ? Math.max(0, Number(inv.totalPaise - credited - inv.paidPaise)) : 0;
    await emit(tx, "ReturnCreditNoteRecorded", { type: "return_credit_note", id: cn.id }, {
      creditNoteId: cn.id, goodsReturnId: id, returnNumber: r.number, supplierInvoiceId: inv.id, orderId: r.orderId, buyerBusinessId: r.buyerBusinessId, sellerBusinessId: r.sellerBusinessId,
      creditNoteNumber: number, totalPaise: total, outstandingPaise: outstanding, refundDuePaise: Math.max(0, Number(inv.paidPaise + credited - inv.totalPaise)), hasIrn: !!irn,
    });
  });
  return reload(actor, id);
}

/**
 * Buyer links a dispute to a rejected return. The dispute itself is opened through @cnote/disputes (the app calls openDispute, then this);
 * we only keep the reference so both sides can navigate from the return to the dispute.
 */
export async function linkReturnDispute(actor: Actor, id: string, disputeId: string): Promise<GoodsReturnView> {
  assertPurchaseOrdersEnabled();
  if (!UUID.test(disputeId)) throw new DomainError("validation", "Invalid dispute reference.");
  await prisma.$transaction(async (tx) => {
    const r = await lockReturn(tx, actor, id, "dispute");
    if (r.disputeId) throw new DomainError("conflict", "A dispute is already linked to this return.");
    await tx.goodsReturn.update({ where: { id }, data: { disputeId } });
    await emit(tx, "GoodsReturnDisputeLinked", { type: "goods_return", id }, { ...ids(r), disputeId });
  });
  return reload(actor, id);
}

/** Invoices of a PO a credit note can be recorded against (seller side): live invoices with their remaining creditable value. */
export async function listCreditableInvoices(actor: Actor, purchaseOrderId: string): Promise<{ id: string; invoiceNumber: string; totalPaise: number; creditedPaise: number; creditablePaise: number }[]> {
  if (!UUID.test(purchaseOrderId)) return [];
  const rows = await prisma.supplierInvoice.findMany({ where: { purchaseOrderId, sellerBusinessId: actor.businessId, status: { not: "void" } }, orderBy: { createdAt: "asc" } });
  return rows.map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, totalPaise: Number(i.totalPaise), creditedPaise: Number(i.creditedPaise), creditablePaise: Number(i.totalPaise - i.creditedPaise) })).filter((i) => i.creditablePaise > 0);
}
