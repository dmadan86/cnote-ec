// Pure rules for goods receipt notes (GRN) and returns (RMA). No database, no clock except through arguments: unit-tested without Postgres.
// docs/design/grn-returns.md.
import { DomainError } from "@cnote/core";
import { addDays, daysBetween } from "./po-core";

// ---- reason codes ----------------------------------------------------------------------------------------------------------------

/** Why units were rejected at receipt. */
export const REJECT_REASONS = ["damaged", "short", "wrong_spec", "quality_fail"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** Why a return is requested (the receipt reasons plus two that only make sense later). */
export const RETURN_REASONS = [...REJECT_REASONS, "not_as_ordered", "other"] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

export const isRejectReason = (v: unknown): v is RejectReason => typeof v === "string" && (REJECT_REASONS as readonly string[]).includes(v);
export const isReturnReason = (v: unknown): v is ReturnReason => typeof v === "string" && (RETURN_REASONS as readonly string[]).includes(v);

// ---- numbering -------------------------------------------------------------------------------------------------------------------

export type DocKind = "grn" | "rma";
const PREFIX: Record<DocKind, string> = { grn: "GRN", rma: "RMA" };

/** "GRN/26-27/000004" / "RMA/26-27/000002": prefix, short financial year, six-digit serial. */
export function formatDocNumber(kind: DocKind, fy: string, n: number): string {
  return `${PREFIX[kind]}/${fy.slice(2)}/${String(n).padStart(6, "0")}`;
}

// ---- receipt lines -----------------------------------------------------------------------------------------------------------------

export const MAX_RECEIPT_QTY = 1_000_000_000;
/** How far back a receipt can be dated. */
export const MAX_BACKDATE_DAYS = 60;

export interface ReceiptLineInput {
  poLineNo: number;
  receivedQty: number;
  /** optional: when given it must equal received - rejected */
  acceptedQty?: number | null;
  rejectedQty?: number | null;
  rejectReason?: string | null;
  rejectNote?: string | null;
}

export interface ReceiptLineChecked {
  poLineNo: number;
  receivedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  rejectReason: RejectReason | null;
  rejectNote: string | null;
}

const whole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);

/**
 * Validates one receipt line: whole non-negative quantities, accepted + rejected = received, a reason when anything is rejected.
 * Over-delivery is handled by the caller against the PO line (see `maxReceivable`).
 */
export function checkReceiptLine(l: ReceiptLineInput, at = "line"): ReceiptLineChecked {
  const bad = (m: string, field = "lines"): never => { throw new DomainError("validation", `${at}: ${m}`, { [field]: m }); };
  if (!whole(l.poLineNo) || l.poLineNo < 1) bad("unknown purchase order line.");
  if (!whole(l.receivedQty) || l.receivedQty < 0 || l.receivedQty > MAX_RECEIPT_QTY) bad("enter the quantity received as a whole number.");
  const rejected = l.rejectedQty == null ? (l.acceptedQty == null ? 0 : l.receivedQty - l.acceptedQty) : l.rejectedQty;
  if (!whole(rejected) || rejected < 0 || rejected > l.receivedQty) bad("rejected quantity cannot be more than the quantity received.");
  const accepted = l.receivedQty - rejected;
  if (l.acceptedQty != null && l.acceptedQty !== accepted) bad("accepted plus rejected must equal received.");
  let reason: RejectReason | null = null;
  if (rejected > 0) {
    if (!isRejectReason(l.rejectReason)) bad("choose a reason for the rejected units.", "rejectReason");
    reason = l.rejectReason as RejectReason;
  }
  const note = l.rejectNote?.trim() || null;
  if (note && note.length > 300) bad("keep the rejection note under 300 characters.", "rejectNote");
  return { poLineNo: l.poLineNo, receivedQty: l.receivedQty, acceptedQty: accepted, rejectedQty: rejected, rejectReason: reason, rejectNote: rejected > 0 ? note : null };
}

/** Most units that can be recorded as received for a PO line: the ordered quantity plus the buyer's quantity tolerance. */
export function maxReceivable(orderedQty: number, receivedBefore: number, qtyToleranceBps: number): number {
  const cap = orderedQty + Math.floor((orderedQty * qtyToleranceBps) / 10_000);
  return Math.max(0, cap - receivedBefore);
}

export function checkReceiptDate(receivedOn: string | null | undefined, today: string): string {
  const field = "receivedOn";
  if (!receivedOn || !/^\d{4}-\d{2}-\d{2}$/.test(receivedOn) || Number.isNaN(Date.parse(`${receivedOn}T00:00:00Z`))) throw new DomainError("validation", "Enter the date the goods were received.", { [field]: "Enter the date the goods were received." });
  if (receivedOn > today) throw new DomainError("validation", "The received date cannot be in the future.", { [field]: "The received date cannot be in the future." });
  if (receivedOn < addDays(today, -MAX_BACKDATE_DAYS)) throw new DomainError("validation", `The received date cannot be more than ${MAX_BACKDATE_DAYS} days ago.`, { [field]: "Too far in the past." });
  return receivedOn;
}

export function checkReceiverName(v: string | null | undefined): string {
  const s = v?.trim() ?? "";
  if (s.length < 2 || s.length > 80) throw new DomainError("validation", "Enter the name of the person who received the goods (2 to 80 characters).", { receiverName: "Enter the receiver's name." });
  return s;
}

// ---- returns ---------------------------------------------------------------------------------------------------------------------

export type ReturnSource = "rejected" | "accepted";
export type ReturnStatus = "requested" | "approved" | "rejected" | "cancelled" | "shipped" | "received" | "credited";

export const RETURN_WINDOW_DEFAULT_DAYS = 30;
export const RETURN_WINDOW_MAX_DAYS = 365;

/** Return window in days (config RETURN_WINDOW_DAYS, 1 to 365, default 30). */
export function returnWindowDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.RETURN_WINDOW_DAYS);
  return Number.isInteger(n) && n >= 1 && n <= RETURN_WINDOW_MAX_DAYS ? n : RETURN_WINDOW_DEFAULT_DAYS;
}

/** Last day (inclusive) a return can be requested for a receipt dated `receivedOn`. */
export const returnDeadline = (receivedOn: string, windowDays: number): string => addDays(receivedOn, windowDays);
export const returnWindowOpen = (receivedOn: string, today: string, windowDays: number): boolean => today <= returnDeadline(receivedOn, windowDays);
export const returnDaysLeft = (receivedOn: string, today: string, windowDays: number): number => daysBetween(today, returnDeadline(receivedOn, windowDays));

/** Statuses in which a return still holds back units from further returns. */
export const LIVE_RETURN_STATUSES: readonly ReturnStatus[] = ["requested", "approved", "shipped", "received", "credited"];
/** Statuses the seller can still act on / that await the next step. */
export const OPEN_RETURN_STATUSES: readonly ReturnStatus[] = ["requested", "approved", "shipped", "received"];

export type ReturnAction = "cancel" | "approve" | "reject" | "ship" | "receive" | "credit" | "dispute";

/** Which role may do what from each status (pure state machine; the service loads, applies and persists). */
export const RETURN_TRANSITIONS: Record<ReturnAction, { from: readonly ReturnStatus[]; role: "buyer" | "seller"; to: ReturnStatus | null }> = {
  cancel: { from: ["requested"], role: "buyer", to: "cancelled" },
  approve: { from: ["requested"], role: "seller", to: "approved" },
  reject: { from: ["requested"], role: "seller", to: "rejected" },
  ship: { from: ["approved"], role: "buyer", to: "shipped" },
  receive: { from: ["approved", "shipped"], role: "seller", to: "received" },
  credit: { from: ["approved", "shipped", "received"], role: "seller", to: "credited" },
  dispute: { from: ["rejected"], role: "buyer", to: null },
};

const ACTION_VERB: Record<ReturnAction, string> = {
  cancel: "cancelled", approve: "approved", reject: "rejected", ship: "marked shipped", receive: "marked received", credit: "credited", dispute: "disputed",
};

export function canReturnAct(status: ReturnStatus, action: ReturnAction, role: "buyer" | "seller"): boolean {
  const t = RETURN_TRANSITIONS[action];
  return t.role === role && t.from.includes(status);
}

export function assertReturnAction(status: ReturnStatus, action: ReturnAction, role: "buyer" | "seller"): ReturnStatus | null {
  const t = RETURN_TRANSITIONS[action];
  if (t.role !== role) throw new DomainError("forbidden", `Only the ${t.role} can do this.`);
  if (!t.from.includes(status)) throw new DomainError("conflict", `A return that is ${status} cannot be ${ACTION_VERB[action]}.`);
  return t.to;
}

export interface ReturnLineInput { receiptLineId: string; quantity: number; source: ReturnSource }

/** Units of a receipt line still returnable from `source`: the rejected or accepted quantity minus what live returns already hold. */
export function returnableQty(line: { acceptedQty: number; rejectedQty: number }, source: ReturnSource, alreadyReturned: number): number {
  return Math.max(0, (source === "rejected" ? line.rejectedQty : line.acceptedQty) - alreadyReturned);
}

/** Credit-note amounts: taxable + GST = total, whole paise. */
export function checkCreditAmounts(taxablePaise: number, gstPaise: number): number {
  const ok = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000_000;
  if (!ok(taxablePaise) || !ok(gstPaise)) throw new DomainError("validation", "Amounts must be whole paise, 0 or more.", { taxable: "Enter a valid amount." });
  if (taxablePaise + gstPaise <= 0) throw new DomainError("validation", "The credit note total must be above 0.", { taxable: "Enter the credited amount." });
  return taxablePaise + gstPaise;
}

/** Credit note number: like an invoice number (CGST Rule 46: up to 16 characters, letters, digits, hyphen, slash). */
export function normaliseCreditNoteNumber(v: string): string {
  const s = v.trim().toUpperCase();
  if (!/^[A-Z0-9/-]{1,16}$/.test(s)) throw new DomainError("validation", "The credit note number can have up to 16 characters: letters, digits, hyphen and slash.", { number: "Up to 16 letters, digits, - or /." });
  return s;
}
