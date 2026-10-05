// Supplier tax invoices recorded by the seller against a purchase order, their e-invoice / e-way bill references, the MSME
// payment due date (IT Act s.43B(h) + MSMED Act s.15) and the buyer's payment records. The platform does NOT issue these
// invoices and moves no money: it stores what the seller states and what the buyer pays (Phase 1, ADR-007).
// docs/design/purchase-orders.md.
import { financialYear } from "@cnote/billing";
import { DomainError, emit } from "@cnote/core";
import { prisma, type Prisma, type SupplierInvoice, type SupplierInvoicePayment, type Tx } from "@cnote/db";
import * as identity from "@cnote/identity";
import { getMediaStore } from "@cnote/media";
import { randomUUID } from "node:crypto";
import { checkAttachment, safeFileName, SIGNED_URL_TTL_SECONDS, type AttachmentAccess, type AttachmentUpload } from "./attachments";
import { getEInvoiceVerifier, qrSvgDataUri, type EInvoiceCheckStatus } from "./einvoice";
import {
  addDays, checkSignedQr, daysRemaining, fromDbDate, isIsoDate, istDate, normaliseAckNo, normaliseEwayBill, normaliseInvoiceNumber, normaliseIrn,
  normalisePaymentReference, reminderStage, statutoryDueDate, STATUTORY_MAX_DAYS, toDbDate, type ReminderStage,
} from "./po-core";
import { matchGateTx, matchSummaryJson } from "./match";
import { profiles } from "./support";
import type { Actor } from "./types";

export const MAX_INVOICE_FILE_BYTES = 5 * 1024 * 1024;
const UUID = /^[0-9a-f-]{36}$/i;
const PAGE = 20;

export function purchaseOrdersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.PURCHASE_ORDERS_ENABLED?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}
export function assertPurchaseOrdersEnabled(): void {
  if (!purchaseOrdersEnabled()) throw new DomainError("forbidden", "Purchase orders are not enabled.");
}

// ---- views ---------------------------------------------------------------------------------------------------------------------

export interface InvoicePaymentView { id: string; amountPaise: number; paidOn: string; reference: string; createdAt: string }

export interface SupplierInvoiceView {
  id: string;
  purchaseOrderId: string;
  orderId: string;
  invoiceNumber: string;
  invoiceDate: string;
  status: "open" | "paid" | "void";
  voidReason: string | null;
  taxablePaise: number;
  gstPaise: number;
  totalPaise: number;
  paidPaise: number;
  /** credit notes recorded against this invoice (returns); they reduce what is payable */
  creditedPaise: number;
  outstandingPaise: number;
  /** paid more than the invoice is worth after credit notes: the seller owes the buyer this (settled off-platform) */
  refundDuePaise: number;
  /** the seller gave line detail (quantity and unit price per PO line), so the three-way match runs per line */
  hasLines: boolean;
  file: { fileName: string; mimeType: string; sizeBytes: number } | null;
  eInvoice: { irn: string; ackNo: string | null; ackDate: string | null; hasSignedQr: boolean; check: EInvoiceCheckStatus; checkNote: string | null; qrDataUri?: string | null } | null;
  ewayBill: { number: string; validUntil: string | null; expired: boolean } | null;
  due: {
    /** the seller was a declared micro/small enterprise with an Udyam number when this was recorded: s.43B(h) applies */
    msmeCovered: boolean;
    agreementBasis: "written_agreement" | "no_agreement";
    agreedDays: number | null;
    /** days actually allowed after acceptance when msmeCovered (45 maximum, 15 with no written agreement) */
    statutoryDays: number | null;
    cappedAtStatutory: boolean;
    dueBasis: "delivery" | "invoice_date";
    acceptanceDate: string;
    dueDate: string | null;
    /** negative once overdue; null when there is no due date or the invoice is settled */
    daysRemaining: number | null;
    overdue: boolean;
    paidLate: boolean;
  };
  payments: InvoicePaymentView[];
  createdAt: string;
}

type InvoiceRow = SupplierInvoice & { payments?: SupplierInvoicePayment[]; lines?: unknown[]; _count?: { lines: number } };

export function toInvoiceView(i: InvoiceRow, now: Date = new Date(), qrDataUri?: string | null): SupplierInvoiceView {
  const today = istDate(now);
  const due = i.dueDate ? fromDbDate(i.dueDate) : null;
  const open = i.status === "open";
  const left = due && open ? daysRemaining(due, today) : null;
  const agreedDays = i.agreedDays;
  const statutoryDays = i.msmeCovered ? (i.agreementBasis === "written_agreement" && agreedDays !== null ? Math.min(agreedDays, STATUTORY_MAX_DAYS) : 15) : null;
  const lastPaid = i.payments?.length ? i.payments.reduce((m, p) => (fromDbDate(p.paidOn) > m ? fromDbDate(p.paidOn) : m), "0000-00-00") : null;
  return {
    id: i.id,
    purchaseOrderId: i.purchaseOrderId,
    orderId: i.orderId,
    invoiceNumber: i.invoiceNumber,
    invoiceDate: fromDbDate(i.invoiceDate),
    status: i.status,
    voidReason: i.voidReason,
    taxablePaise: Number(i.taxablePaise),
    gstPaise: Number(i.gstPaise),
    totalPaise: Number(i.totalPaise),
    paidPaise: Number(i.paidPaise),
    creditedPaise: Number(i.creditedPaise),
    outstandingPaise: open ? Math.max(0, Number(i.totalPaise - i.creditedPaise - i.paidPaise)) : 0,
    refundDuePaise: i.status === "void" ? 0 : Math.max(0, Number(i.paidPaise + i.creditedPaise - i.totalPaise)),
    hasLines: (i.lines?.length ?? i._count?.lines ?? 0) > 0,
    file: i.fileKey ? { fileName: i.fileName ?? "invoice", mimeType: i.fileMime ?? "application/pdf", sizeBytes: i.fileSize ?? 0 } : null,
    eInvoice: i.irn
      ? { irn: i.irn, ackNo: i.ackNo, ackDate: i.ackDate?.toISOString() ?? null, hasSignedQr: !!i.signedQr, check: (i.eInvoiceCheck as EInvoiceCheckStatus | null) ?? "unchecked", checkNote: i.eInvoiceNote, ...(qrDataUri !== undefined ? { qrDataUri } : {}) }
      : null,
    ewayBill: i.ewbNo ? { number: i.ewbNo, validUntil: i.ewbValidUntil?.toISOString() ?? null, expired: !!i.ewbValidUntil && i.ewbValidUntil.getTime() < now.getTime() } : null,
    due: {
      msmeCovered: i.msmeCovered,
      agreementBasis: i.agreementBasis === "written_agreement" ? "written_agreement" : "no_agreement",
      agreedDays,
      statutoryDays,
      cappedAtStatutory: i.msmeCovered && i.agreementBasis === "written_agreement" && agreedDays !== null && agreedDays > STATUTORY_MAX_DAYS,
      dueBasis: i.dueBasis === "delivery" ? "delivery" : "invoice_date",
      acceptanceDate: fromDbDate(i.acceptanceDate),
      dueDate: due,
      daysRemaining: left,
      overdue: left !== null && left < 0,
      paidLate: i.msmeCovered && !!due && i.status === "paid" && !!lastPaid && lastPaid > due,
    },
    payments: (i.payments ?? []).map((p) => ({ id: p.id, amountPaise: Number(p.amountPaise), paidOn: fromDbDate(p.paidOn), reference: p.reference, createdAt: p.createdAt.toISOString() })),
    createdAt: i.createdAt.toISOString(),
  };
}

// ---- recording -----------------------------------------------------------------------------------------------------------------

export interface RecordInvoiceInput {
  purchaseOrderId: string;
  invoiceNumber: string;
  /** "YYYY-MM-DD" */
  invoiceDate: string;
  taxablePaise: number;
  gstPaise: number;
  irn?: string | null;
  ackNo?: string | null;
  /** ISO date or date-time */
  ackDate?: string | null;
  signedQr?: string | null;
  ewbNo?: string | null;
  /** ISO date or date-time */
  ewbValidUntil?: string | null;
  file?: AttachmentUpload | null;
  /** optional line detail (docs/design/grn-returns.md): enables the per-line three-way match. Sum of quantity x unit price must equal taxablePaise. */
  lines?: InvoiceLineInput[] | null;
}

export interface InvoiceLineInput { poLineNo: number; quantity: number; /** per unit, excluding GST */ unitPricePaise: number }

const MAX_INVOICE_LINES = 50;

/** Validates optional invoice line detail against the PO lines and the invoice taxable value. Returns null when no detail was given. */
function checkInvoiceLines(lines: InvoiceLineInput[] | null | undefined, taxable: number, poLineNos: ReadonlySet<number>): InvoiceLineInput[] | null {
  if (!lines || lines.length === 0) return null;
  const bad = (m: string): never => { throw new DomainError("validation", m, { lines: m }); };
  if (lines.length > MAX_INVOICE_LINES) bad(`An invoice can have up to ${MAX_INVOICE_LINES} lines.`);
  const seen = new Set<number>();
  let sum = 0;
  for (const l of lines) {
    if (!Number.isSafeInteger(l.poLineNo) || !poLineNos.has(l.poLineNo)) bad("Each invoice line must refer to a line of the purchase order.");
    if (seen.has(l.poLineNo)) bad("Each purchase order line can appear once on the invoice.");
    seen.add(l.poLineNo);
    if (!Number.isSafeInteger(l.quantity) || l.quantity < 1 || l.quantity > 1_000_000_000) bad("Invoice line quantities must be whole numbers above 0.");
    if (!Number.isSafeInteger(l.unitPricePaise) || l.unitPricePaise < 0 || l.unitPricePaise > 1_000_000_000_000) bad("Invoice line prices must be whole paise, 0 or more.");
    sum += l.quantity * l.unitPricePaise;
    if (!Number.isSafeInteger(sum)) bad("Invoice line amounts are too large.");
  }
  if (sum !== taxable) bad("The invoice lines add up to a different taxable value than the invoice. Check quantity and unit price on each line.");
  return lines;
}

const blank = (v: string | null | undefined): string | null => (v && v.trim() !== "" ? v.trim() : null);
function parseInstant(v: string | null, field: string, msg: string): Date | null {
  if (v === null) return null;
  // Date-only and zone-less date-times (HTML date / datetime-local inputs) are Indian time.
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00+05:30` : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(v) ? `${v}+05:30` : v);
  if (Number.isNaN(d.getTime())) throw new DomainError("validation", msg, { [field]: msg });
  return d;
}

/** Seller records their tax invoice against a PO. Values are validated and stored as stated; nothing is sent to any portal. */
export async function recordSupplierInvoice(actor: Actor, input: RecordInvoiceInput, now: Date = new Date()): Promise<SupplierInvoiceView> {
  assertPurchaseOrdersEnabled();
  if (!UUID.test(input.purchaseOrderId)) throw new DomainError("not_found", "Purchase order not found");
  const invoiceNumber = normaliseInvoiceNumber(input.invoiceNumber);
  if (!isIsoDate(input.invoiceDate)) throw new DomainError("validation", "Enter a valid invoice date.", { invoiceDate: "Enter a valid invoice date." });
  const today = istDate(now);
  if (input.invoiceDate > today) throw new DomainError("validation", "The invoice date cannot be in the future.", { invoiceDate: "The invoice date cannot be in the future." });
  if (input.invoiceDate < addDays(today, -400)) throw new DomainError("validation", "The invoice date is too old.", { invoiceDate: "The invoice date is too old." });
  const money = (v: number, f: string) => {
    if (!Number.isSafeInteger(v) || v < 0 || v > 1_000_000_000_000) throw new DomainError("validation", "Amounts must be whole paise, 0 or more.", { [f]: "Enter a valid amount." });
    return v;
  };
  const taxable = money(input.taxablePaise, "taxable");
  const gst = money(input.gstPaise, "gst");
  const total = taxable + gst;
  if (total <= 0) throw new DomainError("validation", "The invoice total must be above 0.", { taxable: "Enter the taxable value." });

  const irnRaw = blank(input.irn);
  const irn = irnRaw ? normaliseIrn(irnRaw) : null;
  const ackNoRaw = blank(input.ackNo);
  const ackDateRaw = blank(input.ackDate);
  const qrRaw = blank(input.signedQr);
  if (!irn && (ackNoRaw || ackDateRaw || qrRaw)) throw new DomainError("validation", "Enter the IRN together with the acknowledgement details and signed QR.", { irn: "The IRN is required with acknowledgement details." });
  const ackNo = ackNoRaw ? normaliseAckNo(ackNoRaw) : null;
  const ackDate = parseInstant(ackDateRaw, "ackDate", "Enter a valid acknowledgement date.");
  const signedQr = qrRaw ? checkSignedQr(qrRaw) : null;
  const ewbRaw = blank(input.ewbNo);
  const ewbNo = ewbRaw ? normaliseEwayBill(ewbRaw) : null;
  const ewbValidUntil = parseInstant(blank(input.ewbValidUntil), "ewbValidUntil", "Enter a valid e-way bill validity date.");
  if (ewbValidUntil && !ewbNo) throw new DomainError("validation", "Enter the e-way bill number for this validity date.", { ewbNo: "The e-way bill number is required." });
  if (ewbValidUntil && ewbValidUntil.getTime() < toDbDate(input.invoiceDate).getTime() - 86_400_000) throw new DomainError("validation", "The e-way bill cannot expire before the invoice date.", { ewbValidUntil: "The e-way bill cannot expire before the invoice date." });
  const checked = input.file && (input.file.bytes.length > 0 || input.file.fileName) ? checkAttachment(input.file, MAX_INVOICE_FILE_BYTES) : null;

  const po = await prisma.purchaseOrder.findUnique({ where: { id: input.purchaseOrderId }, include: { order: { select: { deliveredAt: true } } } });
  if (!po || po.sellerBusinessId !== actor.businessId) throw new DomainError("not_found", "Purchase order not found");
  const [parties] = await Promise.all([identity.getPartyProfiles([po.sellerBusinessId])]);
  const seller = parties.get(po.sellerBusinessId);
  const verdict = irn
    ? await getEInvoiceVerifier().verify({ irn, ackNo, signedQr, sellerGstin: seller?.gstin ?? null, invoiceNumber, invoiceDate: input.invoiceDate, totalPaise: total })
    : null;

  const id = randomUUID();
  const fileKey = checked ? `invoices/supplier/${id}/${randomUUID()}.${checked.ext}` : null;
  if (checked && fileKey) await getMediaStore("private").put(fileKey, checked.bytes, checked.mime);
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${po.id}::uuid FOR UPDATE`;
      const cur = await tx.purchaseOrder.findUnique({ where: { id: po.id }, include: { versions: { where: { version: po.currentVersion } }, order: { select: { deliveredAt: true } } } });
      const ver = cur?.versions[0];
      if (!cur || !ver) throw new DomainError("not_found", "Purchase order not found");
      if (cur.status !== "issued" && cur.status !== "acknowledged") throw new DomainError("conflict", `This purchase order is ${cur.status}; invoices can no longer be recorded against it.`);
      const live = await tx.supplierInvoice.aggregate({ where: { purchaseOrderId: cur.id, status: { not: "void" } }, _sum: { totalPaise: true } });
      const invoiced = live._sum.totalPaise ?? 0n;
      if (invoiced + BigInt(total) > ver.totalPaise) {
        throw new DomainError("validation", "This invoice would take the total invoiced above the purchase order value. Ask the buyer to amend the purchase order first.", { total: "Above the remaining purchase order value." });
      }
      const lineDetail = checkInvoiceLines(input.lines, taxable, new Set((await tx.purchaseOrderLine.findMany({ where: { versionId: ver.id }, select: { lineNo: true } })).map((l) => l.lineNo)));
      const written = cur.status === "acknowledged";
      const delivered = cur.order.deliveredAt;
      const acceptance = delivered ? istDate(delivered) : input.invoiceDate;
      const covered = !!seller?.msme.covered;
      const agreedDays = ver.paymentTermsDays;
      const dueDate = covered ? statutoryDueDate({ acceptance, agreedDays: written ? agreedDays : null, writtenAgreement: written }).dueDate : addDays(acceptance, agreedDays);
      if (irn && (await tx.supplierInvoice.findUnique({ where: { irn }, select: { id: true } }))) {
        throw new DomainError("conflict", "This IRN is already recorded on another invoice.", { irn: "Already recorded." });
      }
      let row: SupplierInvoice;
      try {
        row = await tx.supplierInvoice.create({
          data: {
            id, purchaseOrderId: cur.id, poVersion: cur.currentVersion, orderId: cur.orderId, buyerBusinessId: cur.buyerBusinessId, sellerBusinessId: cur.sellerBusinessId,
            invoiceNumber, invoiceDate: toDbDate(input.invoiceDate), financialYear: financialYear(toDbDate(input.invoiceDate)),
            taxablePaise: BigInt(taxable), gstPaise: BigInt(gst), totalPaise: BigInt(total),
            fileKey, fileName: checked ? safeFileName(checked.fileName) : null, fileMime: checked?.mime ?? null, fileSize: checked?.bytes.length ?? null,
            irn, ackNo, ackDate, signedQr, eInvoiceCheck: verdict?.status ?? null, eInvoiceNote: verdict?.note ?? null, ewbNo, ewbValidUntil,
            msmeCovered: covered, agreementBasis: written ? "written_agreement" : "no_agreement", agreedDays: written ? agreedDays : null,
            dueBasis: delivered ? "delivery" : "invoice_date", acceptanceDate: toDbDate(acceptance), dueDate: toDbDate(dueDate),
            recordedByPersonId: actor.personId,
          },
        });
      } catch (e) {
        if ((e as { code?: string }).code === "P2002") {
          throw new DomainError("conflict", "You already recorded an invoice with this number for this financial year.", { invoiceNumber: "Already recorded." });
        }
        throw e;
      }
      if (lineDetail) {
        await tx.supplierInvoiceLine.createMany({
          data: lineDetail.map((l, i) => ({ invoiceId: id, lineNo: i + 1, poLineNo: l.poLineNo, quantity: l.quantity, unitPricePaise: BigInt(l.unitPricePaise), taxablePaise: BigInt(l.quantity * l.unitPricePaise) })),
        });
      }
      await emit(tx, "SupplierInvoiceRecorded", { type: "supplier_invoice", id }, {
        supplierInvoiceId: id, purchaseOrderId: cur.id, orderId: cur.orderId, buyerBusinessId: cur.buyerBusinessId, sellerBusinessId: cur.sellerBusinessId,
        invoiceNumber, totalPaise: total, dueDate, msmeCovered: covered, hasIrn: !!irn, hasEwayBill: !!ewbNo,
      });
      return toInvoiceView({ ...row, payments: [], lines: lineDetail ?? [] }, now);
    });
  } catch (e) {
    if (fileKey) await getMediaStore("private").delete(fileKey).catch(() => undefined);
    throw e;
  }
}

// ---- voiding and payments ------------------------------------------------------------------------------------------------------

async function lockInvoice(tx: Tx, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM supplier_invoices WHERE id = ${id}::uuid FOR UPDATE`;
}

/** Seller withdraws an invoice recorded by mistake. Only while nothing has been paid against it. */
export async function voidSupplierInvoice(actor: Actor, invoiceId: string, reason: string): Promise<SupplierInvoiceView> {
  assertPurchaseOrdersEnabled();
  if (!UUID.test(invoiceId)) throw new DomainError("not_found", "Invoice not found");
  const why = reason.trim();
  if (why.length < 3 || why.length > 300) throw new DomainError("validation", "Give a reason (3 to 300 characters).", { reason: "Give a reason (3 to 300 characters)." });
  return prisma.$transaction(async (tx) => {
    await lockInvoice(tx, invoiceId);
    const inv = await tx.supplierInvoice.findUnique({ where: { id: invoiceId }, include: { payments: true, _count: { select: { lines: true } } } });
    if (!inv || inv.sellerBusinessId !== actor.businessId) throw new DomainError("not_found", "Invoice not found");
    if (inv.status !== "open") throw new DomainError("conflict", `This invoice is ${inv.status}.`);
    if (inv.paidPaise > 0n) throw new DomainError("conflict", "A payment is already recorded against this invoice, so it cannot be withdrawn.");
    const row = await tx.supplierInvoice.update({ where: { id: invoiceId }, data: { status: "void", voidReason: why }, include: { payments: true, _count: { select: { lines: true } } } });
    await emit(tx, "SupplierInvoiceVoided", { type: "supplier_invoice", id: invoiceId }, {
      supplierInvoiceId: invoiceId, purchaseOrderId: inv.purchaseOrderId, orderId: inv.orderId, buyerBusinessId: inv.buyerBusinessId, sellerBusinessId: inv.sellerBusinessId, invoiceNumber: inv.invoiceNumber, reason: why, system: false,
    });
    return toInvoiceView(row);
  });
}

export interface RecordPaymentInput {
  /** default: the full outstanding amount */
  amountPaise?: number | null;
  /** "YYYY-MM-DD" */
  paidOn: string;
  /** UTR / bank reference */
  reference: string;
  /**
   * Pay although the three-way match blocks it (mismatch, or no goods receipt yet when the buyer blocks on that): the reason is logged
   * in `invoice_match_overrides` and shown on the match view. Ignored when nothing blocks.
   */
  overrideReason?: string | null;
}

/** Buyer records a payment (full or part) they made to the seller. */
export async function recordInvoicePayment(actor: Actor, invoiceId: string, input: RecordPaymentInput, now: Date = new Date()): Promise<SupplierInvoiceView> {
  assertPurchaseOrdersEnabled();
  if (!UUID.test(invoiceId)) throw new DomainError("not_found", "Invoice not found");
  if (!isIsoDate(input.paidOn)) throw new DomainError("validation", "Enter the payment date.", { paidOn: "Enter the payment date." });
  const today = istDate(now);
  if (input.paidOn > today) throw new DomainError("validation", "The payment date cannot be in the future.", { paidOn: "The payment date cannot be in the future." });
  const reference = normalisePaymentReference(input.reference);
  return prisma.$transaction(async (tx) => {
    await lockInvoice(tx, invoiceId);
    const inv = await tx.supplierInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv || inv.buyerBusinessId !== actor.businessId) throw new DomainError("not_found", "Invoice not found");
    if (inv.status !== "open") throw new DomainError("conflict", `This invoice is ${inv.status}.`);
    if (input.paidOn < fromDbDate(inv.invoiceDate)) throw new DomainError("validation", "The payment date cannot be before the invoice date.", { paidOn: "The payment date cannot be before the invoice date." });
    const outstanding = inv.totalPaise - inv.creditedPaise - inv.paidPaise;
    if (outstanding <= 0n) throw new DomainError("conflict", "Nothing is outstanding on this invoice.");
    const amount = input.amountPaise == null ? outstanding : BigInt(input.amountPaise);
    if (typeof amount !== "bigint" || amount <= 0n || (input.amountPaise != null && !Number.isSafeInteger(input.amountPaise))) throw new DomainError("validation", "Enter a valid amount.", { amount: "Enter a valid amount." });
    if (amount > outstanding) throw new DomainError("validation", "The amount is more than the outstanding balance.", { amount: "More than the outstanding balance." });
    // Three-way match gate (docs/design/grn-returns.md): a mismatch blocks "mark paid" unless the buyer overrides with a logged reason.
    const gate = await matchGateTx(tx, inv);
    if (gate.gate.blocked) {
      const why = input.overrideReason?.trim() ?? "";
      if (!why) {
        throw new DomainError("conflict", gate.gate.reason === "mismatch"
          ? "This invoice does not match the purchase order and the goods received. Resolve it with the seller, or pay anyway with a reason."
          : "No goods receipt is recorded for this purchase order yet. Record the receipt, or pay anyway with a reason.", { matchBlocked: gate.gate.reason, invoiceId });
      }
      if (why.length < 5 || why.length > 300) throw new DomainError("validation", "Give a reason (5 to 300 characters).", { overrideReason: "Give a reason (5 to 300 characters)." });
      await tx.invoiceMatchOverride.create({ data: { invoiceId, fingerprint: gate.match.fingerprint, reason: why, summary: matchSummaryJson(gate.match), byPersonId: actor.personId } });
      await emit(tx, "InvoiceMatchOverridden", { type: "supplier_invoice", id: invoiceId }, {
        supplierInvoiceId: invoiceId, purchaseOrderId: inv.purchaseOrderId, orderId: inv.orderId, buyerBusinessId: inv.buyerBusinessId, sellerBusinessId: inv.sellerBusinessId,
        invoiceNumber: inv.invoiceNumber, matchStatus: gate.gate.reason,
      });
    }
    try {
      await tx.supplierInvoicePayment.create({ data: { invoiceId, amountPaise: amount, paidOn: toDbDate(input.paidOn), reference, byPersonId: actor.personId } });
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw new DomainError("conflict", "This reference is already recorded for this invoice.", { reference: "Already recorded." });
      throw e;
    }
    const paid = inv.paidPaise + amount;
    const fully = paid + inv.creditedPaise >= inv.totalPaise;
    const row = await tx.supplierInvoice.update({ where: { id: invoiceId }, data: { paidPaise: paid, ...(fully ? { status: "paid", paidAt: now } : {}) }, include: { payments: true, _count: { select: { lines: true } } } });
    const due = inv.dueDate ? fromDbDate(inv.dueDate) : null;
    await emit(tx, "SupplierInvoicePaymentRecorded", { type: "supplier_invoice", id: invoiceId }, {
      supplierInvoiceId: invoiceId, purchaseOrderId: inv.purchaseOrderId, orderId: inv.orderId, buyerBusinessId: inv.buyerBusinessId, sellerBusinessId: inv.sellerBusinessId,
      amountPaise: Number(amount), paidOn: input.paidOn, fullyPaid: fully, msmeCovered: inv.msmeCovered, late: inv.msmeCovered && !!due && input.paidOn > due,
    });
    return toInvoiceView(row, now);
  });
}

// ---- order hooks (called from orders.ts inside the order's transaction) ----------------------------------------------------------

/**
 * Delivery confirmed: invoices recorded before this used the invoice date as the day of acceptance. Move them to the delivery date
 * (MSMED Act s.15: the period runs from the day of acceptance, not from the invoice).
 */
export async function onOrderDeliveredTx(tx: Tx, orderId: string, deliveredAt: Date): Promise<number> {
  const day = istDate(deliveredAt);
  const rows = await tx.supplierInvoice.findMany({ where: { orderId, status: "open", dueBasis: "invoice_date" } });
  for (const r of rows) {
    const written = r.agreementBasis === "written_agreement";
    const dueDate = r.msmeCovered ? statutoryDueDate({ acceptance: day, agreedDays: written ? r.agreedDays : null, writtenAgreement: written }).dueDate : addDays(day, r.agreedDays ?? 0);
    await tx.supplierInvoice.update({ where: { id: r.id }, data: { dueBasis: "delivery", acceptanceDate: toDbDate(day), dueDate: toDbDate(dueDate) } });
  }
  return rows.length;
}

/** Order cancelled: unpaid invoices are withdrawn by the system (those with payments are kept for the record). */
export async function voidOpenInvoicesForOrderTx(tx: Tx, orderId: string, reason: string): Promise<number> {
  const rows = await tx.supplierInvoice.findMany({ where: { orderId, status: "open", paidPaise: 0n } });
  for (const r of rows) {
    await tx.supplierInvoice.update({ where: { id: r.id }, data: { status: "void", voidReason: reason } });
    await emit(tx, "SupplierInvoiceVoided", { type: "supplier_invoice", id: r.id }, {
      supplierInvoiceId: r.id, purchaseOrderId: r.purchaseOrderId, orderId: r.orderId, buyerBusinessId: r.buyerBusinessId, sellerBusinessId: r.sellerBusinessId, invoiceNumber: r.invoiceNumber, reason, system: true,
    });
  }
  return rows.length;
}

// ---- reads ---------------------------------------------------------------------------------------------------------------------

export async function getSupplierInvoice(actor: Actor, invoiceId: string, now: Date = new Date()): Promise<SupplierInvoiceView | null> {
  if (!UUID.test(invoiceId)) return null;
  const inv = await prisma.supplierInvoice.findUnique({ where: { id: invoiceId }, include: { payments: { orderBy: { createdAt: "asc" } }, _count: { select: { lines: true } } } });
  if (!inv || (inv.buyerBusinessId !== actor.businessId && inv.sellerBusinessId !== actor.businessId)) return null;
  const qr = inv.signedQr ? await qrSvgDataUri(inv.signedQr) : null;
  return toInvoiceView(inv, now, inv.irn ? qr : undefined);
}

/** Authorised read of the uploaded invoice copy (buyer or seller of the invoice); null otherwise. */
export async function openSupplierInvoiceFile(actor: Actor, invoiceId: string): Promise<AttachmentAccess | null> {
  if (!UUID.test(invoiceId)) return null;
  const inv = await prisma.supplierInvoice.findUnique({ where: { id: invoiceId } });
  if (!inv?.fileKey || (inv.buyerBusinessId !== actor.businessId && inv.sellerBusinessId !== actor.businessId)) return null;
  const store = getMediaStore("private");
  const signedUrl = await store.signedGetUrl(inv.fileKey, SIGNED_URL_TTL_SECONDS);
  const meta = { fileName: inv.fileName ?? "invoice.pdf", mimeType: inv.fileMime ?? "application/pdf" };
  if (signedUrl) return { ...meta, signedUrl, bytes: null };
  const obj = await store.get(inv.fileKey);
  return obj ? { ...meta, signedUrl: null, bytes: obj.bytes } : null;
}

export interface PayableRow extends SupplierInvoiceView {
  sellerName: string;
  buyerName: string;
  purchaseOrderNumber: string;
}

async function toPayableRows(rows: (SupplierInvoice & { payments: SupplierInvoicePayment[]; purchaseOrder: { number: string } })[], now: Date): Promise<PayableRow[]> {
  const profs = await profiles(rows.flatMap((r) => [r.buyerBusinessId, r.sellerBusinessId]));
  return rows.map((r) => ({
    ...toInvoiceView(r, now),
    sellerName: profs.get(r.sellerBusinessId)?.name ?? "Seller",
    buyerName: profs.get(r.buyerBusinessId)?.name ?? "Buyer",
    purchaseOrderNumber: r.purchaseOrder.number,
  }));
}

export interface PayablesSummary { openCount: number; openPaise: number; overdueCount: number; overduePaise: number; dueSoonCount: number; msmeOpenCount: number }
export interface PayablesPage { items: PayableRow[]; nextCursor: string | null; summary: PayablesSummary }
export type PayablesFilter = "open" | "overdue" | "paid" | "all";

/** The buyer's supplier invoices, soonest due first (open ones), with a summary of what is open / overdue / due within 7 days. */
export async function listBuyerPayables(actor: Actor, opts: { filter?: PayablesFilter; cursor?: string | null } = {}, now: Date = new Date()): Promise<PayablesPage> {
  const filter = opts.filter ?? "open";
  const today = toDbDate(istDate(now));
  const base = { buyerBusinessId: actor.businessId, status: { not: "void" as const } };
  const where: Prisma.SupplierInvoiceWhereInput =
    filter === "open" ? { ...base, status: "open" } : filter === "overdue" ? { ...base, status: "open", dueDate: { lt: today } } : filter === "paid" ? { ...base, status: "paid" } : base;
  const cursor = opts.cursor && UUID.test(opts.cursor) ? { id: opts.cursor } : undefined;
  const [rows, open, overdue, dueSoon, msmeOpen] = await Promise.all([
    prisma.supplierInvoice.findMany({
      where, include: { payments: true, _count: { select: { lines: true } }, purchaseOrder: { select: { number: true } } },
      orderBy: filter === "paid" || filter === "all" ? [{ createdAt: "desc" }, { id: "desc" }] : [{ dueDate: { sort: "asc", nulls: "last" } }, { id: "asc" }],
      take: PAGE + 1, ...(cursor ? { cursor, skip: 1 } : {}),
    }),
    prisma.supplierInvoice.aggregate({ where: { ...base, status: "open" }, _count: true, _sum: { totalPaise: true, creditedPaise: true, paidPaise: true } }),
    prisma.supplierInvoice.aggregate({ where: { ...base, status: "open", dueDate: { lt: today } }, _count: true, _sum: { totalPaise: true, creditedPaise: true, paidPaise: true } }),
    prisma.supplierInvoice.count({ where: { ...base, status: "open", dueDate: { gte: today, lte: toDbDate(addDays(istDate(now), 7)) } } }),
    prisma.supplierInvoice.count({ where: { ...base, status: "open", msmeCovered: true } }),
  ]);
  const page = rows.slice(0, PAGE);
  const out = (a: typeof open) => Number((a._sum.totalPaise ?? 0n) - (a._sum.creditedPaise ?? 0n) - (a._sum.paidPaise ?? 0n));
  return {
    items: await toPayableRows(page, now),
    nextCursor: rows.length > PAGE ? page[page.length - 1]!.id : null,
    summary: { openCount: open._count, openPaise: out(open), overdueCount: overdue._count, overduePaise: out(overdue), dueSoonCount: dueSoon, msmeOpenCount: msmeOpen },
  };
}

/** Staff read-only view (admin): open MSME-covered payables past their statutory due date, longest overdue first. */
export async function listOverdueMsmePayables(opts: { cursor?: string | null; limit?: number; minDaysOverdue?: number } = {}, now: Date = new Date()): Promise<{ items: PayableRow[]; nextCursor: string | null; totalOverdue: number; totalOverduePaise: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const cutoff = toDbDate(addDays(istDate(now), -Math.max(1, opts.minDaysOverdue ?? 1) + 1));
  const where: Prisma.SupplierInvoiceWhereInput = { status: "open", msmeCovered: true, dueDate: { lt: cutoff } };
  const cursor = opts.cursor && UUID.test(opts.cursor) ? { id: opts.cursor } : undefined;
  const [rows, agg] = await Promise.all([
    prisma.supplierInvoice.findMany({ where, include: { payments: true, _count: { select: { lines: true } }, purchaseOrder: { select: { number: true } } }, orderBy: [{ dueDate: "asc" }, { id: "asc" }], take: limit + 1, ...(cursor ? { cursor, skip: 1 } : {}) }),
    prisma.supplierInvoice.aggregate({ where, _count: true, _sum: { totalPaise: true, creditedPaise: true, paidPaise: true } }),
  ]);
  const page = rows.slice(0, limit);
  return { items: await toPayableRows(page, now), nextCursor: rows.length > limit ? page[page.length - 1]!.id : null, totalOverdue: agg._count, totalOverduePaise: Number((agg._sum.totalPaise ?? 0n) - (agg._sum.creditedPaise ?? 0n) - (agg._sum.paidPaise ?? 0n)) };
}

// ---- reminders (scheduled job in the module worker) -----------------------------------------------------------------------------

/**
 * Emits SupplierInvoiceDueReminder for open MSME-covered invoices at T-7, T-1 and overdue, once per stage per invoice
 * (a SupplierInvoiceReminder row is written in the same transaction as the event, so a re-run or a second worker sends
 * nothing twice). A stage that was skipped because the job was down is skipped for good: only the current stage is sent.
 * Returns the number of reminders emitted.
 */
export async function sendPayableReminders(now: Date = new Date(), opts: { batch?: number } = {}): Promise<number> {
  if (!purchaseOrdersEnabled()) return 0;
  const today = istDate(now);
  const horizon = toDbDate(addDays(today, 7));
  let sent = 0;
  let after: string | undefined;
  for (;;) {
    const rows = await prisma.supplierInvoice.findMany({
      where: { status: "open", msmeCovered: true, dueDate: { lte: horizon } },
      include: { reminders: true },
      orderBy: { id: "asc" },
      take: opts.batch ?? 200,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.id;
    for (const inv of rows) {
      const due = fromDbDate(inv.dueDate!);
      const stage: ReminderStage | null = reminderStage(due, today);
      if (!stage || inv.reminders.some((r) => r.stage === stage)) continue;
      const ok = await prisma.$transaction(async (tx) => {
        const fresh = await tx.supplierInvoice.findUnique({ where: { id: inv.id }, select: { status: true, paidPaise: true, creditedPaise: true, totalPaise: true } });
        if (!fresh || fresh.status !== "open") return false;
        const created = await tx.supplierInvoiceReminder.createMany({ data: [{ invoiceId: inv.id, stage }], skipDuplicates: true });
        if (created.count === 0) return false;
        await emit(tx, "SupplierInvoiceDueReminder", { type: "supplier_invoice", id: inv.id }, {
          supplierInvoiceId: inv.id, purchaseOrderId: inv.purchaseOrderId, orderId: inv.orderId, buyerBusinessId: inv.buyerBusinessId, sellerBusinessId: inv.sellerBusinessId,
          invoiceNumber: inv.invoiceNumber, stage, dueDate: due, outstandingPaise: Number(fresh.totalPaise - fresh.creditedPaise - fresh.paidPaise), daysOverdue: Math.max(0, -daysRemaining(due, today)),
        });
        return true;
      });
      if (ok) sent++;
    }
    if (rows.length < (opts.batch ?? 200)) break;
  }
  return sent;
}
