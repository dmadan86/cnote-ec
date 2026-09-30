// Pure FormData -> @cnote/a2a input parsing (unit-tested). Errors are catalogue keys so the client can show them in the buyer's language.
import { parseRupees, UUID_RE } from "./labels";

export type FieldErrors = Record<string, string>;
const str = (f: FormData, k: string): string => {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
};
const on = (f: FormData, k: string) => f.get(k) === "on";

const parseInt10 = (v: string, min: number, max: number): number | null => (/^\d{1,9}$/.test(v) && Number(v) >= min && Number(v) <= max ? Number(v) : null);

/** "YYYY-MM-DD" -> end of that day in India (the buyer's calendar), as an ISO instant. */
export function endOfDayIst(date: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const iso = `${date}T23:59:59+05:30`;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  // Date.parse rolls 2027-02-30 over to March; reject anything that does not round-trip to the same calendar day (in IST).
  return new Date(ms + 330 * 60_000).toISOString().slice(0, 10) === date ? iso : null;
}

export interface MandateFormValues {
  name: string; title: string; requirement: string; categorySlug: string | null;
  quantity: number; unit: string;
  targetPricePaise: number | null; limitPricePaise: number;
  maxLeadTimeDays: number | null; approvedSellerIds: string[];
  recurrenceDays: number | null; expiresAt: string | null;
}

function common(f: FormData, errors: FieldErrors): Partial<MandateFormValues> {
  const out: Partial<MandateFormValues> = {};
  out.name = str(f, "name");
  if (out.name.length < 3) errors.name = "errRequired";
  out.title = str(f, "title");
  if (out.title.length < 5) errors.title = "errRequired";
  out.requirement = str(f, "requirement");
  if (out.requirement.length < 10) errors.requirement = "errRequired";
  out.categorySlug = str(f, "categorySlug") || null;
  const qty = parseInt10(str(f, "quantity"), 1, 2_000_000_000);
  if (qty === null) errors.quantity = "errInt"; else out.quantity = qty;
  out.unit = str(f, "unit");
  if (!out.unit) errors.unit = "errRequired";

  const target = str(f, "target");
  if (target) {
    const p = parseRupees(target);
    if (p === null) errors.target = "errMoney"; else out.targetPricePaise = p;
  } else out.targetPricePaise = null;
  const max = parseRupees(str(f, "max"));
  if (max === null) errors.max = "errMoney"; else out.limitPricePaise = max;

  const lead = str(f, "lead");
  if (lead) {
    const n = parseInt10(lead, 1, 365);
    if (n === null) errors.lead = "errInt"; else out.maxLeadTimeDays = n;
  } else out.maxLeadTimeDays = null;

  const ids = str(f, "sellers").split(/[\s,;]+/).filter(Boolean);
  if (ids.some((i) => !UUID_RE.test(i)) || ids.length > 50) errors.sellers = "errSellers";
  else out.approvedSellerIds = [...new Set(ids.map((i) => i.toLowerCase()))];

  if (str(f, "recurMode") === "every") {
    const n = parseInt10(str(f, "recurDays"), 1, 365);
    if (n === null) errors.recurDays = "errInt"; else out.recurrenceDays = n;
  } else out.recurrenceDays = null;

  const exp = str(f, "expiry");
  if (exp) {
    const iso = endOfDayIst(exp);
    if (iso === null) errors.expiry = "errDate"; else out.expiresAt = iso;
  } else out.expiresAt = null;
  return out;
}

export function parseCreate(f: FormData): { ok: true; value: MandateFormValues & { autoAccept: boolean; autoAcceptConsent: boolean; autoAcceptLimitPaise: number | null } } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const v = common(f, errors);
  if (!on(f, "optIn")) errors.optIn = "errConsent";
  const auto = on(f, "autoAccept");
  let autoLimit: number | null = null;
  if (auto) {
    if (!on(f, "autoConsent")) errors.autoConsent = "errConsent";
    autoLimit = parseRupees(str(f, "autoLimit"));
    if (autoLimit === null) errors.autoLimit = "errMoney";
    else if (v.limitPricePaise !== undefined && autoLimit > v.limitPricePaise) errors.autoLimit = "errCeiling";
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { ...(v as MandateFormValues), autoAccept: auto, autoAcceptConsent: auto, autoAcceptLimitPaise: auto ? autoLimit : null } };
}

export function parseEdit(f: FormData): { ok: true; value: MandateFormValues } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const v = common(f, errors);
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: v as MandateFormValues };
}

/** Enabling auto-accept from the detail page: explicit consent + a ceiling that is not above the maximum price. */
export function parseAutoOn(f: FormData, maxPaise: number | null): { ok: true; limitPricePaise: number } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  if (!on(f, "autoConsent")) errors.autoConsent = "errConsent";
  const limit = parseRupees(str(f, "autoLimit"));
  if (limit === null) errors.autoLimit = "errMoney";
  else if (maxPaise !== null && limit > maxPaise) errors.autoLimit = "errCeiling";
  if (Object.keys(errors).length || limit === null) return { ok: false, errors };
  return { ok: true, limitPricePaise: limit };
}
