// Query-string filters of the cookie-consent log, shared by the page and the CSV export so both always select the same rows.
import { COOKIE_CONSENT_ACTIONS, type CookieConsentAction, type CookieConsentSearch } from "@cnote/compliance";

const IST = "+05:30";
const DAY_MS = 86_400_000;

export interface ConsentFilterInput {
  q?: string;
  from?: string;
  to?: string;
  v?: string;
  action?: string;
}

/** `to` is an inclusive IST calendar day in the UI and an exclusive instant (next midnight IST) in the query. */
export function parseConsentFilters(i: ConsentFilterInput): { filters: CookieConsentSearch; problem: string | null } {
  const filters: CookieConsentSearch = {};
  const date = (s: string, end: boolean): Date | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(`${s}T00:00:00${IST}`);
    return Number.isNaN(d.getTime()) ? null : end ? new Date(d.getTime() + DAY_MS) : d;
  };
  if (i.q) filters.q = i.q.trim().slice(0, 64);
  if (i.from) {
    const d = date(i.from, false);
    if (!d) return { filters, problem: "The start date is not a valid date." };
    filters.from = d;
  }
  if (i.to) {
    const d = date(i.to, true);
    if (!d) return { filters, problem: "The end date is not a valid date." };
    filters.to = d;
  }
  if (filters.from && filters.to && filters.from >= filters.to) return { filters, problem: "The start date must be on or before the end date." };
  if (i.v) {
    const n = Number(i.v);
    if (!Number.isInteger(n) || n < 1 || n > 10_000) return { filters, problem: "The policy version must be a whole number." };
    filters.policyVersion = n;
  }
  if (i.action) {
    if (!(COOKIE_CONSENT_ACTIONS as readonly string[]).includes(i.action)) return { filters, problem: "Unknown action." };
    filters.action = i.action as CookieConsentAction;
  }
  return { filters, problem: null };
}

const FORMULA = /^[=+\-@\t\r]/;
/** One CSV cell: quoted when needed, and neutralised against spreadsheet formula injection. */
export function csvCell(v: string | number | boolean | null | undefined): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (FORMULA.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADER = ["receipt_id", "recorded_at", "choice_at", "consent_id", "person_id", "policy_version", "registry_hash", "action", "analytics", "marketing", "gpc", "locale"] as const;

export function csvRow(r: { id: string; createdAt: string; clientAt: number | null; consentId: string; personId: string | null; policyVersion: number; registryHash: string | null; action: string; analytics: boolean; marketing: boolean; gpc: boolean; locale: string }): string {
  return [r.id, r.createdAt, r.clientAt ? new Date(r.clientAt * 1000).toISOString() : "", r.consentId, r.personId, r.policyVersion, r.registryHash, r.action, r.analytics, r.marketing, r.gpc, r.locale].map(csvCell).join(",");
}
