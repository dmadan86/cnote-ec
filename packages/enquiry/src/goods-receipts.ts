// Goods receipt notes (GRN): the buyer records what physically arrived against a purchase order, line by line (received, accepted, rejected with
// a reason code), with photos, the received date and the receiver's name. One PO can have several partial GRNs. The first GRN with accepted units
// is the buyer's delivery confirmation (day of acceptance for MSMED s.15 / IT Act s.43B(h)), see orders.acceptDeliveryOnReceiptTx.
// A GRN is never edited after it is recorded: a correction is another GRN or a return. docs/design/grn-returns.md.
import { financialYear } from "@cnote/billing";
import { DomainError, emit } from "@cnote/core";
import { prisma, type GoodsReceipt, type GoodsReceiptLine, type GoodsReceiptPhoto, type Tx } from "@cnote/db";
import { getMediaStore } from "@cnote/media";
import { randomUUID } from "node:crypto";
import { checkAttachment, safeFileName, SIGNED_URL_TTL_SECONDS, type AttachmentAccess, type AttachmentUpload } from "./attachments";
import {
  checkReceiptDate, checkReceiptLine, checkReceiverName, formatDocNumber, maxReceivable, returnDaysLeft, returnDeadline, returnWindowDays, returnWindowOpen,
  type DocKind, type ReceiptLineChecked, type ReceiptLineInput, type RejectReason,
} from "./grn-core";
import { getBuyerMatchSettings } from "./match";
import { acceptDeliveryOnReceiptTx } from "./orders";
import { fromDbDate, istDate, toDbDate } from "./po-core";
import { assertPurchaseOrdersEnabled } from "./supplier-invoices";
import type { Actor } from "./types";

const UUID = /^[0-9a-f-]{36}$/i;
export const MAX_GRN_PHOTOS = 5;
export const MAX_GRN_PHOTO_BYTES = 5 * 1024 * 1024;
/** Order statuses in which goods can be received (the seller has dispatched). */
const RECEIVABLE_ORDER_STATUSES = ["dispatched", "delivered", "completed"];

// ---- numbering -------------------------------------------------------------------------------------------------------------------

/**
 * Next gap-free number per buyer business, document kind and financial year. The upsert row-locks the counter until the creating
 * transaction ends, so concurrent creators serialise and a rollback releases the number (the same approach as the PO sequence).
 */
export async function nextDocNumber(tx: Tx, buyerBusinessId: string, kind: DocKind, fy: string): Promise<string> {
  const rows = await tx.$queryRaw<{ last_number: number }[]>`
    INSERT INTO document_sequences (buyer_business_id, kind, financial_year, last_number) VALUES (${buyerBusinessId}::uuid, ${kind}, ${fy}, 1)
    ON CONFLICT (buyer_business_id, kind, financial_year) DO UPDATE SET last_number = document_sequences.last_number + 1
    RETURNING last_number`;
  return formatDocNumber(kind, fy, rows[0]!.last_number);
}

// ---- views -----------------------------------------------------------------------------------------------------------------------

export interface ReceiptLineView {
  id: string;
  poLineNo: number;
  description: string;
  unit: string;
  receivedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  rejectReason: RejectReason | null;
  rejectNote: string | null;
  unitPricePaise: number;
}
export interface ReceiptPhotoView { id: string; poLineNo: number | null; fileName: string; mimeType: string; sizeBytes: number }

export interface GoodsReceiptView {
  id: string;
  number: string;
  purchaseOrderId: string;
  orderId: string;
  receivedOn: string;
  receiverName: string;
  deliveryNoteRef: string | null;
  note: string | null;
  /** this receipt confirmed delivery (first receipt with accepted units) */
  confirmedDelivery: boolean;
  createdAt: string;
  lines: ReceiptLineView[];
  photos: ReceiptPhotoView[];
  acceptedUnits: number;
  rejectedUnits: number;
  /** returns can be raised until this date (inclusive) */
  returnWindow: { deadline: string; daysLeft: number; open: boolean };
}

type ReceiptRow = GoodsReceipt & { lines: GoodsReceiptLine[]; photos: GoodsReceiptPhoto[] };

export function toReceiptView(r: ReceiptRow, now: Date = new Date()): GoodsReceiptView {
  const received = fromDbDate(r.receivedOn);
  const today = istDate(now);
  const window = returnWindowDays();
  const lines = [...r.lines].sort((a, b) => a.poLineNo - b.poLineNo);
  return {
    id: r.id, number: r.number, purchaseOrderId: r.purchaseOrderId, orderId: r.orderId, receivedOn: received, receiverName: r.receiverName,
    deliveryNoteRef: r.deliveryNoteRef, note: r.note, confirmedDelivery: r.confirmedDelivery, createdAt: r.createdAt.toISOString(),
    lines: lines.map((l) => ({
      id: l.id, poLineNo: l.poLineNo, description: l.description, unit: l.unit, receivedQty: l.receivedQty, acceptedQty: l.acceptedQty, rejectedQty: l.rejectedQty,
      rejectReason: l.rejectReason as RejectReason | null, rejectNote: l.rejectNote, unitPricePaise: Number(l.unitPricePaise),
    })),
    photos: [...r.photos].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((p) => ({ id: p.id, poLineNo: p.poLineNo, fileName: p.fileName, mimeType: p.mimeType, sizeBytes: p.sizeBytes })),
    acceptedUnits: lines.reduce((s, l) => s + l.acceptedQty, 0),
    rejectedUnits: lines.reduce((s, l) => s + l.rejectedQty, 0),
    returnWindow: { deadline: returnDeadline(received, window), daysLeft: returnDaysLeft(received, today, window), open: returnWindowOpen(received, today, window) },
  };
}

const INCLUDE = { lines: true, photos: true } as const;

// ---- receiving status (the form's source of truth) -----------------------------------------------------------------------------------

export interface ReceivingLineStatus {
  lineNo: number;
  description: string;
  unit: string;
  orderedQty: number;
  receivedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  /** most that can still be recorded as received (ordered + the buyer's quantity tolerance, less what was already received) */
  maxReceivable: number;
}
export interface ReceivingStatusView {
  purchaseOrderId: string;
  number: string;
  orderId: string;
  canReceive: boolean;
  /** why not, in English (shown as-is) */
  blockedReason: string | null;
  qtyToleranceBps: number;
  lines: ReceivingLineStatus[];
  receiptCount: number;
}

async function receivingSummary(db: Pick<Tx, "goodsReceiptLine">, purchaseOrderId: string): Promise<Map<number, { received: number; accepted: number; rejected: number }>> {
  const rows = await db.goodsReceiptLine.groupBy({ by: ["poLineNo"], where: { receipt: { purchaseOrderId } }, _sum: { receivedQty: true, acceptedQty: true, rejectedQty: true } });
  return new Map(rows.map((r) => [r.poLineNo, { received: r._sum.receivedQty ?? 0, accepted: r._sum.acceptedQty ?? 0, rejected: r._sum.rejectedQty ?? 0 }]));
}

function receivableReason(poStatus: string, orderStatus: string): string | null {
  if (poStatus === "cancelled") return "This purchase order is cancelled.";
  if (poStatus === "rejected") return "The seller rejected this purchase order.";
  if (orderStatus === "cancelled") return "This order is cancelled.";
  if (!RECEIVABLE_ORDER_STATUSES.includes(orderStatus)) return "The seller has not marked this order dispatched yet. Ask them to mark it dispatched, then record the receipt.";
  return null;
}

export async function getReceivingStatus(actor: Actor, purchaseOrderId: string): Promise<ReceivingStatusView | null> {
  if (!UUID.test(purchaseOrderId)) return null;
  const po = await prisma.purchaseOrder.findUnique({ where: { id: purchaseOrderId }, include: { versions: { include: { lines: true } }, order: { select: { status: true } } } });
  if (!po || po.buyerBusinessId !== actor.businessId) return null;
  const ver = po.versions.find((v) => v.version === po.currentVersion)!;
  const [summary, settings] = await Promise.all([receivingSummary(prisma, po.id), getBuyerMatchSettings(po.buyerBusinessId)]);
  const blockedReason = receivableReason(po.status, po.order.status);
  return {
    purchaseOrderId: po.id, number: po.number, orderId: po.orderId, canReceive: blockedReason === null, blockedReason, qtyToleranceBps: settings.qtyToleranceBps,
    receiptCount: await prisma.goodsReceipt.count({ where: { purchaseOrderId: po.id } }),
    lines: [...ver.lines].sort((a, b) => a.lineNo - b.lineNo).map((l) => {
      const s = summary.get(l.lineNo) ?? { received: 0, accepted: 0, rejected: 0 };
      return { lineNo: l.lineNo, description: l.description, unit: l.unit, orderedQty: l.quantity, receivedQty: s.received, acceptedQty: s.accepted, rejectedQty: s.rejected, maxReceivable: maxReceivable(l.quantity, s.received, settings.qtyToleranceBps) };
    }),
  };
}

// ---- recording -------------------------------------------------------------------------------------------------------------------

export interface RecordReceiptInput {
  purchaseOrderId: string;
  /** "YYYY-MM-DD" (today or earlier, up to 60 days back) */
  receivedOn: string;
  receiverName: string;
  /** supplier delivery challan / LR number */
  deliveryNoteRef?: string | null;
  note?: string | null;
  lines: ReceiptLineInput[];
  /** up to 5 photos (JPG/PNG, 5 MB each) of the delivery or the damage */
  photos?: (AttachmentUpload & { poLineNo?: number | null })[] | null;
}

const clean = (v: string | null | undefined, max: number, field: string): string | null => {
  const s = v?.trim();
  if (!s) return null;
  if (s.length > max) throw new DomainError("validation", `Keep this under ${max} characters.`, { [field]: `Keep this under ${max} characters.` });
  return s;
};

/** Buyer records a goods receipt. All-or-nothing: the photos are removed again if the receipt cannot be saved. */
export async function recordGoodsReceipt(actor: Actor, input: RecordReceiptInput, now: Date = new Date()): Promise<GoodsReceiptView> {
  assertPurchaseOrdersEnabled();
  if (!UUID.test(input.purchaseOrderId)) throw new DomainError("not_found", "Purchase order not found");
  const today = istDate(now);
  const receivedOn = checkReceiptDate(input.receivedOn, today);
  const receiverName = checkReceiverName(input.receiverName);
  const deliveryNoteRef = clean(input.deliveryNoteRef, 40, "deliveryNoteRef");
  const note = clean(input.note, 500, "note");
  const checkedLines: ReceiptLineChecked[] = [];
  const seen = new Set<number>();
  for (const l of input.lines ?? []) {
    const c = checkReceiptLine(l, `line ${l.poLineNo}`);
    if (seen.has(c.poLineNo)) throw new DomainError("validation", "Each purchase order line can appear once on a receipt.", { lines: "Each line can appear once." });
    seen.add(c.poLineNo);
    if (c.receivedQty > 0) checkedLines.push(c);
  }
  if (checkedLines.length === 0) throw new DomainError("validation", "Enter the quantity received for at least one line.", { lines: "Enter a quantity received." });

  const uploads = (input.photos ?? []).filter((p) => p.bytes.length > 0 || p.fileName);
  if (uploads.length > MAX_GRN_PHOTOS) throw new DomainError("validation", `You can add up to ${MAX_GRN_PHOTOS} photos.`, { photos: `Up to ${MAX_GRN_PHOTOS} photos.` });
  const photos = uploads.map((p) => {
    const c = checkAttachment(p, MAX_GRN_PHOTO_BYTES);
    if (c.mime === "application/pdf") throw new DomainError("validation", "Photos must be JPG or PNG files.", { photos: "Photos must be JPG or PNG." });
    if (p.poLineNo != null && !seen.has(p.poLineNo)) throw new DomainError("validation", "A photo refers to a line that is not on this receipt.", { photos: "Unknown line." });
    return { ...c, poLineNo: p.poLineNo ?? null };
  });

  const head = await prisma.purchaseOrder.findUnique({ where: { id: input.purchaseOrderId }, select: { buyerBusinessId: true } });
  if (!head || head.buyerBusinessId !== actor.businessId) throw new DomainError("not_found", "Purchase order not found");

  const id = randomUUID();
  const store = getMediaStore("private");
  const stored: { id: string; key: string; fileName: string; mime: string; size: number; poLineNo: number | null }[] = [];
  try {
    for (const p of photos) {
      const pid = randomUUID();
      const key = `grn/${id}/${pid}.${p.ext}`;
      await store.put(key, p.bytes, p.mime);
      stored.push({ id: pid, key, fileName: safeFileName(p.fileName), mime: p.mime, size: p.bytes.length, poLineNo: p.poLineNo });
    }
    const view = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${input.purchaseOrderId}::uuid FOR UPDATE`;
      const po = await tx.purchaseOrder.findUnique({
        where: { id: input.purchaseOrderId },
        include: { versions: { include: { lines: true } }, order: { select: { status: true } } },
      });
      if (!po || po.buyerBusinessId !== actor.businessId) throw new DomainError("not_found", "Purchase order not found");
      const blocked = receivableReason(po.status, po.order.status);
      if (blocked) throw new DomainError("conflict", blocked);
      const ver = po.versions.find((v) => v.version === po.currentVersion)!;
      const byNo = new Map(ver.lines.map((l) => [l.lineNo, l]));
      const [before, settings] = await Promise.all([receivingSummary(tx, po.id), getBuyerMatchSettings(po.buyerBusinessId, tx)]);
      for (const c of checkedLines) {
        const pl = byNo.get(c.poLineNo);
        if (!pl) throw new DomainError("validation", `Line ${c.poLineNo} is not on this purchase order.`, { lines: "Unknown line." });
        const room = maxReceivable(pl.quantity, before.get(c.poLineNo)?.received ?? 0, settings.qtyToleranceBps);
        if (c.receivedQty > room) {
          throw new DomainError("validation", `Line ${c.poLineNo}: only ${room} more ${pl.unit} can be received (ordered ${pl.quantity}, already received ${before.get(c.poLineNo)?.received ?? 0}).`, { lines: `Only ${room} more can be received.` });
        }
      }
      const number = await nextDocNumber(tx, po.buyerBusinessId, "grn", financialYear(now));
      const acceptedUnits = checkedLines.reduce((s, c) => s + c.acceptedQty, 0);
      const rejectedUnits = checkedLines.reduce((s, c) => s + c.rejectedQty, 0);
      const confirmed = acceptedUnits > 0 ? await acceptDeliveryOnReceiptTx(tx, po.orderId, receivedOn, now) : false;
      const row = await tx.goodsReceipt.create({
        data: {
          id, purchaseOrderId: po.id, orderId: po.orderId, buyerBusinessId: po.buyerBusinessId, sellerBusinessId: po.sellerBusinessId, number, financialYear: financialYear(now),
          receivedOn: toDbDate(receivedOn), receiverName, deliveryNoteRef, note, confirmedDelivery: confirmed, createdByPersonId: actor.personId,
          lines: {
            create: checkedLines.map((c) => {
              const pl = byNo.get(c.poLineNo)!;
              return {
                poLineNo: c.poLineNo, description: pl.description, unit: pl.unit, receivedQty: c.receivedQty, acceptedQty: c.acceptedQty, rejectedQty: c.rejectedQty,
                rejectReason: c.rejectReason, rejectNote: c.rejectNote, unitPricePaise: BigInt(pl.quantity > 0 ? Math.round(Number(pl.taxablePaise) / pl.quantity) : Number(pl.unitPricePaise)),
              };
            }),
          },
          photos: { create: stored.map((s) => ({ id: s.id, poLineNo: s.poLineNo, key: s.key, fileName: s.fileName, mimeType: s.mime, sizeBytes: s.size })) },
        },
        include: INCLUDE,
      });
      await emit(tx, "GoodsReceiptRecorded", { type: "goods_receipt", id }, {
        goodsReceiptId: id, number, purchaseOrderId: po.id, orderId: po.orderId, buyerBusinessId: po.buyerBusinessId, sellerBusinessId: po.sellerBusinessId,
        receivedOn, acceptedUnits, rejectedUnits, deliveryConfirmed: confirmed,
      });
      return toReceiptView(row, now);
    });
    return view;
  } catch (e) {
    await Promise.all(stored.map((s) => store.delete(s.key).catch(() => undefined)));
    throw e;
  }
}

// ---- reads ---------------------------------------------------------------------------------------------------------------------

function mine(r: Pick<GoodsReceipt, "buyerBusinessId" | "sellerBusinessId">, actor: Actor): boolean {
  return r.buyerBusinessId === actor.businessId || r.sellerBusinessId === actor.businessId;
}

export async function getGoodsReceipt(actor: Actor, id: string, now: Date = new Date()): Promise<GoodsReceiptView | null> {
  if (!UUID.test(id)) return null;
  const r = await prisma.goodsReceipt.findUnique({ where: { id }, include: INCLUDE });
  return r && mine(r, actor) ? toReceiptView(r, now) : null;
}

/** Receipts of an order (oldest first) for its buyer or seller. */
export async function listGoodsReceiptsForOrder(actor: Actor, orderId: string, now: Date = new Date()): Promise<GoodsReceiptView[]> {
  if (!UUID.test(orderId)) return [];
  const rows = await prisma.goodsReceipt.findMany({
    where: { orderId, OR: [{ buyerBusinessId: actor.businessId }, { sellerBusinessId: actor.businessId }] },
    include: INCLUDE, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map((r) => toReceiptView(r, now));
}

/** Authorised read of a receipt photo (buyer or seller of the receipt): a short-lived signed URL, or the bytes when the driver cannot sign. */
export async function openGoodsReceiptPhoto(actor: Actor, photoId: string): Promise<AttachmentAccess | null> {
  if (!UUID.test(photoId)) return null;
  const p = await prisma.goodsReceiptPhoto.findUnique({ where: { id: photoId }, include: { receipt: { select: { buyerBusinessId: true, sellerBusinessId: true } } } });
  if (!p || !mine(p.receipt, actor)) return null;
  const store = getMediaStore("private");
  const meta = { fileName: p.fileName, mimeType: p.mimeType };
  const signedUrl = await store.signedGetUrl(p.key, SIGNED_URL_TTL_SECONDS);
  if (signedUrl) return { ...meta, signedUrl, bytes: null };
  const obj = await store.get(p.key);
  return obj ? { ...meta, signedUrl: null, bytes: obj.bytes } : null;
}
