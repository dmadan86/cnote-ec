// Pure rules for purchase orders, supplier invoices, e-invoice / e-way bill references and the MSME payment due date.
// No database, no clock except through arguments: every function here is unit-tested without Postgres.
// See docs/design/purchase-orders.md for the legal basis (IT Act s.43B(h), MSMED Act s.15, CGST Rule 46, e-invoice schema).
import { splitGst, splitInclusive } from "@cnote/billing";
import { DomainError } from "@cnote/core";

// ---- dates (Indian calendar dates as "YYYY-MM-DD") -------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** The Indian-calendar date (IST, UTC+5:30) of an instant. */
export function istDate(d: Date): string {
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00.000Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00.000Z`).getTime() - new Date(`${a}T00:00:00.000Z`).getTime()) / DAY_MS);
}

export const toDbDate = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
export const fromDbDate = (d: Date): string => d.toISOString().slice(0, 10);

// ---- MSME s.43B(h) due date ------------------------------------------------------------------------------------------------

/** MSMED Act s.15(1): the agreed credit period may not exceed 45 days from the day of acceptance or deemed acceptance. */
export const STATUTORY_MAX_DAYS = 45;
/** MSMED Act s.15(1): with no written agreement the buyer pays before the appointed day, 15 days after acceptance. */
export const NO_AGREEMENT_DAYS = 15;

export interface StatutoryDue {
  /** "YYYY-MM-DD" */
  dueDate: string;
  /** days allowed from the acceptance date */
  days: number;
  /** the agreed terms were longer than the statutory maximum and were capped */
  capped: boolean;
}

/**
 * Statutory payment due date = acceptance date + min(agreed days, 45); with no written agreement, acceptance + 15.
 * `acceptance` is the day goods were accepted (the buyer's delivery confirmation; the invoice date until that is known).
 */
export function statutoryDueDate(i: { acceptance: string; agreedDays: number | null; writtenAgreement: boolean }): StatutoryDue {
  if (!isIsoDate(i.acceptance)) throw new DomainError("validation", "Invalid acceptance date.");
  if (!i.writtenAgreement || i.agreedDays === null) return { dueDate: addDays(i.acceptance, NO_AGREEMENT_DAYS), days: NO_AGREEMENT_DAYS, capped: false };
  const agreed = Math.max(0, Math.trunc(i.agreedDays));
  const days = Math.min(agreed, STATUTORY_MAX_DAYS);
  return { dueDate: addDays(i.acceptance, days), days, capped: agreed > STATUTORY_MAX_DAYS };
}

export type ReminderStage = "t7" | "t1" | "overdue";

/** Days left until the due date (negative once overdue), counted on Indian calendar dates. */
export const daysRemaining = (dueDate: string, today: string): number => daysBetween(today, dueDate);

/** The most urgent reminder stage that applies today: t7 (7..2 days left), t1 (1 or 0 days left), overdue (past due), else null. */
export function reminderStage(dueDate: string, today: string): ReminderStage | null {
  const left = daysRemaining(dueDate, today);
  if (left < 0) return "overdue";
  if (left <= 1) return "t1";
  if (left <= 7) return "t7";
  return null;
}

// ---- payment terms ---------------------------------------------------------------------------------------------------------

/** Quote payment terms mapped to credit days; null = free text, the buyer states the days. */
export function paymentTermsToDays(terms: string | null | undefined): number | null {
  switch (terms) {
    case "advance": case "on_delivery": case "escrow": return 0;
    case "net_7": return 7;
    case "net_15": return 15;
    case "net_30": return 30;
    default: return null;
  }
}

export const MAX_PAYMENT_TERMS_DAYS = 180;

// ---- PO lines and totals ---------------------------------------------------------------------------------------------------

export interface PoLineInput {
  description: string;
  hsn?: string | null;
  quantity: number;
  unit: string;
  /** per-unit price in paise */
  unitPricePaise: number;
  /** GST rate in basis points (1800 = 18%) */
  gstRateBps: number;
  /** the unit price already includes GST */
  priceIncludesGst?: boolean;
  quoteId?: string | null;
}

export interface PoLine {
  lineNo: number;
  description: string;
  hsn: string | null;
  quantity: number;
  unit: string;
  unitPricePaise: number;
  priceIncludesGst: boolean;
  gstRateBps: number;
  taxablePaise: number;
  taxPaise: number;
  totalPaise: number;
  quoteId: string | null;
}

export interface PoTotals { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; taxPaise: number; totalPaise: number }

const MAX_LINE_PAISE = 1_000_000_000_000; // 10,000,000,000 rupees: keeps price x rate inside Number's exact range
export const MAX_PO_LINES = 50;

export function checkLine(l: PoLineInput, at = "line"): void {
  const bad = (m: string): never => { throw new DomainError("validation", `${at}: ${m}`); };
  if (typeof l.description !== "string" || l.description.trim().length < 2 || l.description.length > 300) bad("describe the item (2 to 300 characters).");
  if (l.hsn != null && l.hsn !== "" && !/^\d{2,8}$/.test(l.hsn)) bad("HSN must be 2 to 8 digits.");
  if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 2_000_000_000) bad("quantity must be a whole number above 0.");
  if (typeof l.unit !== "string" || l.unit.trim() === "" || l.unit.length > 32) bad("enter the unit.");
  if (!Number.isInteger(l.unitPricePaise) || l.unitPricePaise < 0) bad("price must be whole paise, 0 or more.");
  if (!Number.isInteger(l.gstRateBps) || l.gstRateBps < 0 || l.gstRateBps > 4000) bad("GST rate must be between 0% and 40%.");
  if (l.unitPricePaise * l.quantity > MAX_LINE_PAISE) bad("the line value is too large.");
}

/** Computes every line and the document totals. `intraState` decides CGST+SGST (true) versus IGST (false). */
export function computePo(lines: PoLineInput[], intraState: boolean): { lines: PoLine[]; totals: PoTotals } {
  if (lines.length === 0) throw new DomainError("validation", "A purchase order needs at least one line.");
  if (lines.length > MAX_PO_LINES) throw new DomainError("validation", `A purchase order can have up to ${MAX_PO_LINES} lines.`);
  const out: PoLine[] = [];
  const sum = { taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 };
  lines.forEach((l, i) => {
    checkLine(l, `Line ${i + 1}`);
    const gross = l.unitPricePaise * l.quantity;
    const s = l.priceIncludesGst ? splitInclusive(gross, l.gstRateBps, intraState) : splitGst(gross, l.gstRateBps, intraState);
    sum.taxablePaise += s.taxablePaise; sum.cgstPaise += s.cgstPaise; sum.sgstPaise += s.sgstPaise; sum.igstPaise += s.igstPaise;
    out.push({
      lineNo: i + 1, description: l.description.trim(), hsn: l.hsn ? l.hsn : null, quantity: l.quantity, unit: l.unit.trim(),
      unitPricePaise: l.unitPricePaise, priceIncludesGst: !!l.priceIncludesGst, gstRateBps: l.gstRateBps,
      taxablePaise: s.taxablePaise, taxPaise: s.gstPaise, totalPaise: s.totalPaise, quoteId: l.quoteId ?? null,
    });
  });
  const taxPaise = sum.cgstPaise + sum.sgstPaise + sum.igstPaise;
  return { lines: out, totals: { ...sum, taxPaise, totalPaise: sum.taxablePaise + taxPaise } };
}

/** Intra-state supply (CGST+SGST) when the place of supply (delivery state) equals the seller's state. Unknown seller state: IGST. */
export const isIntraState = (placeOfSupply: string, sellerStateCode: string | null): boolean => !!sellerStateCode && placeOfSupply === sellerStateCode;

// ---- numbering -------------------------------------------------------------------------------------------------------------

/** "PO/26-27/000012": prefix, short financial year, six-digit serial (15 characters). */
export function formatPoNumber(fy: string, n: number): string {
  return `PO/${fy.slice(2)}/${String(n).padStart(6, "0")}`;
}

// ---- field validators (e-invoice, e-way bill, invoice, payment) --------------------------------------------------------------

/** IRN: the 64-character lowercase or uppercase hex SHA-256 hash from the Invoice Registration Portal. Returned lowercase. */
export function normaliseIrn(v: string): string {
  const s = v.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) throw new DomainError("validation", "The IRN must be 64 hexadecimal characters.", { irn: "The IRN must be 64 hexadecimal characters." });
  return s;
}

/** E-way bill number: exactly 12 digits. */
export function normaliseEwayBill(v: string): string {
  const s = v.replace(/\s+/g, "");
  if (!/^\d{12}$/.test(s)) throw new DomainError("validation", "The e-way bill number must be 12 digits.", { ewbNo: "The e-way bill number must be 12 digits." });
  return s;
}

/** IRP acknowledgement number: a 15-digit number on current IRP output; accept 10 to 20 digits. */
export function normaliseAckNo(v: string): string {
  const s = v.replace(/\s+/g, "");
  if (!/^\d{10,20}$/.test(s)) throw new DomainError("validation", "The acknowledgement number must be 10 to 20 digits.", { ackNo: "The acknowledgement number must be 10 to 20 digits." });
  return s;
}

/** CGST Rule 46: serial number of at most 16 characters, letters, digits, hyphen and slash only. */
export function normaliseInvoiceNumber(v: string): string {
  const s = v.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9/-]{0,15}$/.test(s)) {
    const m = "Invoice number: up to 16 characters, letters, digits, hyphen and slash only.";
    throw new DomainError("validation", m, { invoiceNumber: m });
  }
  return s;
}

/** UTR / bank reference: NEFT 16, RTGS 22, IMPS and UPI 12 characters; accept 6 to 30 letters and digits. */
export function normalisePaymentReference(v: string): string {
  const s = v.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,30}$/.test(s)) {
    const m = "Enter the UTR or bank reference (6 to 30 letters and digits).";
    throw new DomainError("validation", m, { reference: m });
  }
  return s;
}

/** Signed e-invoice QR payload (a JWT string); stored as text and rendered as a QR image. Bounded to what one QR can hold. */
export const MAX_SIGNED_QR_CHARS = 2900;
export function checkSignedQr(v: string): string {
  const s = v.trim();
  if (s.length < 20 || s.length > MAX_SIGNED_QR_CHARS || /[\u0000-\u001f]/.test(s)) {
    const m = `The signed QR text must be 20 to ${MAX_SIGNED_QR_CHARS} characters.`;
    throw new DomainError("validation", m, { signedQr: m });
  }
  return s;
}
