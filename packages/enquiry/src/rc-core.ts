// Pure rules for rate contracts (docs/design/rate-contracts.md): term validation, consumption against caps, price-variation limits,
// warning thresholds, expiry reminders, renewal dates and numbering. No database and no clock except through arguments, so every
// function here is unit-tested without Postgres.
import { DomainError } from "@cnote/core";
import { addDays, daysBetween, isIsoDate, MAX_PAYMENT_TERMS_DAYS } from "./po-core";

export const PRICE_BASES = ["ex_works", "for_destination", "delivered", "other"] as const;
export type PriceBasis = (typeof PRICE_BASES)[number];
export const VARIATION_KINDS = ["fixed", "indexed"] as const;
export type VariationKind = (typeof VARIATION_KINDS)[number];

export const MAX_RC_ITEMS = 50;
/** A contract may run for up to 5 years. */
export const MAX_RC_DAYS = 5 * 366;
/** The widest price-variation band a contract may declare: 50%. */
export const MAX_VARIATION_BPS = 5000;
const MAX_LINE_PAISE = 1_000_000_000_000; // keeps price x quantity inside Number's exact range
const MAX_QTY = 2_000_000_000;

export const WARN_THRESHOLDS = [80, 100] as const;
export type WarnThreshold = (typeof WARN_THRESHOLDS)[number];
export const EXPIRY_REMINDER_DAYS = [30, 7] as const;

export interface RcItemInput {
  /** keep the key of an existing item when amending so consumption carries over; omit for a new item */
  itemKey?: string | null;
  listingId?: string | null;
  description: string;
  hsn?: string | null;
  unit: string;
  /** per-unit price in paise, before GST */
  unitPricePaise: number;
  gstRateBps: number;
  /** minimum quantity per call-off */
  moq?: number | null;
  /** cap on the total quantity over the life of the contract */
  quantityCap?: number | null;
  variationKind?: VariationKind | null;
  variationCapBps?: number | null;
  variationNote?: string | null;
}

export interface RcTermsInput {
  /** "YYYY-MM-DD" */
  validFrom: string;
  validTo: string;
  paymentTermsDays: number;
  priceBasis: PriceBasis;
  /** cap on the total taxable value of all call-offs, paise */
  valueCapPaise?: number | null;
  notes?: string | null;
  changeNote?: string | null;
  items: RcItemInput[];
}

export interface RcItem {
  itemKey: string | null;
  listingId: string | null;
  description: string;
  hsn: string | null;
  unit: string;
  unitPricePaise: number;
  gstRateBps: number;
  moq: number | null;
  quantityCap: number | null;
  variationKind: VariationKind;
  variationCapBps: number | null;
  variationNote: string | null;
}

export interface RcTerms {
  validFrom: string;
  validTo: string;
  paymentTermsDays: number;
  priceBasis: PriceBasis;
  valueCapPaise: number | null;
  notes: string | null;
  changeNote: string | null;
  items: RcItem[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (field: string, message: string): never => {
  throw new DomainError("validation", message, { [field]: message });
};
const text = (v: string | null | undefined, max: number, field: string): string | null => {
  const s = v?.trim();
  if (!s) return null;
  if (s.length > max) fail(field, `Keep this under ${max} characters.`);
  return s;
};
const optInt = (v: number | null | undefined, min: number, max: number, field: string, what: string): number | null => {
  if (v === null || v === undefined) return null;
  if (!Number.isInteger(v) || v < min || v > max) fail(field, `${what} must be a whole number from ${min} to ${max}.`);
  return v;
};

export function normaliseItem(i: RcItemInput, at: string): RcItem {
  const p = (m: string): never => fail("items", `${at}: ${m}`);
  const description = i.description?.trim() ?? "";
  if (description.length < 2 || description.length > 300) p("describe the item (2 to 300 characters).");
  if (i.hsn != null && i.hsn !== "" && !/^\d{2,8}$/.test(i.hsn)) p("HSN must be 2 to 8 digits.");
  const unit = i.unit?.trim() ?? "";
  if (unit === "" || unit.length > 32) p("enter the unit.");
  if (!Number.isInteger(i.unitPricePaise) || i.unitPricePaise < 1 || i.unitPricePaise > MAX_LINE_PAISE) p("enter the unit price in rupees (more than 0).");
  if (!Number.isInteger(i.gstRateBps) || i.gstRateBps < 0 || i.gstRateBps > 4000) p("GST rate must be between 0% and 40%.");
  if (i.itemKey != null && i.itemKey !== "" && !UUID.test(i.itemKey)) p("unknown item.");
  if (i.listingId != null && i.listingId !== "" && !UUID.test(i.listingId)) p("unknown product.");
  const moq = optInt(i.moq, 1, MAX_QTY, "items", `${at}: minimum order quantity`);
  const quantityCap = optInt(i.quantityCap, 1, MAX_QTY, "items", `${at}: quantity cap`);
  if (moq !== null && quantityCap !== null && moq > quantityCap) p("the minimum per call-off cannot exceed the quantity cap.");
  if (quantityCap !== null && quantityCap * i.unitPricePaise > MAX_LINE_PAISE * 100) p("the quantity cap is too large.");
  const kind = i.variationKind ?? "fixed";
  if (!VARIATION_KINDS.includes(kind)) p("price variation must be fixed or indexed.");
  let variationCapBps: number | null = null;
  let variationNote: string | null = null;
  if (kind === "indexed") {
    variationCapBps = optInt(i.variationCapBps, 1, MAX_VARIATION_BPS, "items", `${at}: variation cap`);
    if (variationCapBps === null) p("an indexed price needs a cap (percent the price may move up or down).");
    variationNote = text(i.variationNote, 300, "items");
    if (!variationNote || variationNote.length < 3) p("say what the price is indexed to (for example the monthly average of a published index).");
  }
  return {
    itemKey: i.itemKey ? i.itemKey.toLowerCase() : null, listingId: i.listingId ? i.listingId.toLowerCase() : null, description, hsn: i.hsn ? i.hsn : null, unit,
    unitPricePaise: i.unitPricePaise, gstRateBps: i.gstRateBps, moq, quantityCap, variationKind: kind, variationCapBps, variationNote,
  };
}

/** Validates and normalises the terms of one revision. `today` is the Indian calendar date. */
export function normaliseTerms(i: RcTermsInput, today: string): RcTerms {
  if (!isIsoDate(i.validFrom)) fail("validFrom", "Enter a valid start date.");
  if (!isIsoDate(i.validTo)) fail("validTo", "Enter a valid end date.");
  if (i.validTo < i.validFrom) fail("validTo", "The end date cannot be before the start date.");
  if (daysBetween(i.validFrom, i.validTo) > MAX_RC_DAYS) fail("validTo", "A rate contract can run for at most 5 years.");
  if (i.validTo < today) fail("validTo", "The end date is already in the past.");
  if (!Number.isInteger(i.paymentTermsDays) || i.paymentTermsDays < 0 || i.paymentTermsDays > MAX_PAYMENT_TERMS_DAYS) {
    fail("paymentTermsDays", `Enter the payment terms in days (0 to ${MAX_PAYMENT_TERMS_DAYS}).`);
  }
  if (!PRICE_BASES.includes(i.priceBasis)) fail("priceBasis", "Choose what the prices include.");
  const valueCapPaise = optInt(i.valueCapPaise, 1, Number.MAX_SAFE_INTEGER, "valueCapPaise", "The value cap");
  if (!Array.isArray(i.items) || i.items.length === 0) fail("items", "Add at least one item.");
  if (i.items.length > MAX_RC_ITEMS) fail("items", `A contract can have up to ${MAX_RC_ITEMS} items.`);
  const items = i.items.map((it, n) => normaliseItem(it, `Item ${n + 1}`));
  const keys = items.flatMap((x) => (x.itemKey ? [x.itemKey] : []));
  if (new Set(keys).size !== keys.length) fail("items", "The same item appears twice.");
  return {
    validFrom: i.validFrom, validTo: i.validTo, paymentTermsDays: i.paymentTermsDays, priceBasis: i.priceBasis, valueCapPaise,
    notes: text(i.notes, 2000, "notes"), changeNote: text(i.changeNote, 500, "changeNote"), items,
  };
}

/** "RC/26-27/000012": prefix, short financial year, six-digit serial. */
export function formatRcNumber(fy: string, n: number): string {
  return `RC/${fy.slice(2)}/${String(n).padStart(6, "0")}`;
}

// ---- when a contract is in force -----------------------------------------------------------------------------------------------

export type Phase = "not_started" | "in_force" | "ended";

/** Where `today` falls relative to an accepted revision's dates. */
export function phaseOf(validFrom: string, validTo: string, today: string): Phase {
  return today < validFrom ? "not_started" : today > validTo ? "ended" : "in_force";
}

/** 30 or 7 when a reminder is due today (the most urgent applicable stage only), else null. Nothing after the end date. */
export function expiryReminderStage(validTo: string, today: string): 30 | 7 | null {
  const left = daysBetween(today, validTo);
  if (left < 0) return null;
  if (left <= 7) return 7;
  if (left <= 30) return 30;
  return null;
}

/** An explicit renewal starts the day after the old end (or today if later) and runs as long as the old one did. */
export function renewalDates(prevFrom: string, prevTo: string, today: string): { validFrom: string; validTo: string } {
  const length = Math.min(daysBetween(prevFrom, prevTo), MAX_RC_DAYS);
  const start = addDays(prevTo, 1);
  const validFrom = start > today ? start : today;
  return { validFrom, validTo: addDays(validFrom, length) };
}

// ---- consumption and call-offs ----------------------------------------------------------------------------------------------

export interface Consumption { quantity: number; valuePaise: number }
export type ConsumptionMap = Map<string, Consumption>;

/** Totals per item key over the lines of call-offs that are still placed. */
export function sumConsumption(lines: { itemKey: string; quantity: number; taxablePaise: number }[]): { byItem: ConsumptionMap; valuePaise: number } {
  const byItem: ConsumptionMap = new Map();
  let valuePaise = 0;
  for (const l of lines) {
    const c = byItem.get(l.itemKey) ?? { quantity: 0, valuePaise: 0 };
    c.quantity += l.quantity;
    c.valuePaise += l.taxablePaise;
    byItem.set(l.itemKey, c);
    valuePaise += l.taxablePaise;
  }
  return { byItem, valuePaise };
}

export interface CallOffLineInput {
  itemKey: string;
  quantity: number;
  /** only for an indexed item: the price for this call-off, within the item's cap */
  unitPricePaise?: number | null;
}

export interface ContractItemForCallOff {
  itemKey: string;
  description: string;
  unit: string;
  unitPricePaise: number;
  moq: number | null;
  quantityCap: number | null;
  variationKind: string;
  variationCapBps: number | null;
}

export interface PricedCallOffLine {
  itemKey: string;
  lineNo: number;
  description: string;
  unit: string;
  quantity: number;
  contractPricePaise: number;
  appliedPricePaise: number;
  taxablePaise: number;
}

/** Lowest and highest price an indexed item may be called off at. */
export function variationBand(contractPricePaise: number, capBps: number): { min: number; max: number } {
  const delta = Math.floor((contractPricePaise * capBps) / 10_000);
  return { min: Math.max(1, contractPricePaise - delta), max: contractPricePaise + delta };
}

/**
 * Prices a call-off against a contract: the contract price is locked (an indexed item may move inside its band), the minimum per
 * call-off applies, and neither the per-item quantity cap nor the contract value cap may be exceeded by this call-off together
 * with what earlier call-offs consumed. Throws a DomainError naming the first problem.
 */
export function priceCallOff(
  items: ContractItemForCallOff[], valueCapPaise: number | null, consumed: { byItem: ConsumptionMap; valuePaise: number }, lines: CallOffLineInput[],
): { lines: PricedCallOffLine[]; taxablePaise: number } {
  if (!Array.isArray(lines) || lines.length === 0) fail("lines", "Pick at least one item and a quantity.");
  if (lines.length > MAX_RC_ITEMS) fail("lines", `A call-off can have up to ${MAX_RC_ITEMS} lines.`);
  const byKey = new Map(items.map((i) => [i.itemKey, i]));
  const seen = new Set<string>();
  const out: PricedCallOffLine[] = [];
  let taxable = 0;
  lines.forEach((l, n) => {
    const at = `Line ${n + 1}`;
    const it = byKey.get(l.itemKey?.toLowerCase?.() ?? "");
    if (!it) return fail("lines", `${at}: this item is not on the contract.`);
    if (seen.has(it.itemKey)) return fail("lines", `${at}: ${it.description} is listed twice.`);
    seen.add(it.itemKey);
    if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > MAX_QTY) return fail("lines", `${at}: enter a whole quantity above 0.`);
    if (it.moq !== null && l.quantity < it.moq) return fail("lines", `${at}: the minimum per call-off for ${it.description} is ${it.moq} ${it.unit}.`);
    const used = consumed.byItem.get(it.itemKey)?.quantity ?? 0;
    if (it.quantityCap !== null && used + l.quantity > it.quantityCap) {
      const left = Math.max(0, it.quantityCap - used);
      return fail("lines", `${at}: only ${left} ${it.unit} of ${it.description} is left on this contract.`);
    }
    let applied = it.unitPricePaise;
    if (l.unitPricePaise != null && l.unitPricePaise !== it.unitPricePaise) {
      if (it.variationKind !== "indexed" || it.variationCapBps === null) return fail("lines", `${at}: the price of ${it.description} is fixed by the contract.`);
      if (!Number.isInteger(l.unitPricePaise)) return fail("lines", `${at}: price must be whole paise.`);
      const band = variationBand(it.unitPricePaise, it.variationCapBps);
      if (l.unitPricePaise < band.min || l.unitPricePaise > band.max) return fail("lines", `${at}: the price must stay within ${it.variationCapBps / 100}% of the contract price.`);
      applied = l.unitPricePaise;
    }
    const value = applied * l.quantity;
    if (value > MAX_LINE_PAISE) return fail("lines", `${at}: the line value is too large.`);
    taxable += value;
    out.push({ itemKey: it.itemKey, lineNo: n + 1, description: it.description, unit: it.unit, quantity: l.quantity, contractPricePaise: it.unitPricePaise, appliedPricePaise: applied, taxablePaise: value });
  });
  if (valueCapPaise !== null && consumed.valuePaise + taxable > valueCapPaise) {
    const left = Math.max(0, valueCapPaise - consumed.valuePaise);
    fail("lines", `This call-off would go over the contract value limit. ₹${(left / 100).toLocaleString("en-IN")} is left before tax.`);
  }
  return { lines: out, taxablePaise: taxable };
}

/** Whole-number percent used (rounded down; 100 means the cap is fully used or passed). */
export function usedPercent(used: number, cap: number): number {
  if (cap <= 0) return 100;
  return Math.min(100, Math.floor((used * 100) / cap));
}

/** Warning thresholds crossed when consumption moves from `before` to `after` against `cap` (each at most once, ascending). */
export function thresholdsCrossed(before: number, after: number, cap: number | null): WarnThreshold[] {
  if (cap === null || cap <= 0) return [];
  return WARN_THRESHOLDS.filter((t) => before * 100 < cap * t && after * 100 >= cap * t);
}
