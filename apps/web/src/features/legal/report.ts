// Abuse / IPR takedown report (IT Rules 2021 r.3(1)(d)): pure validation and the mapping onto a grievance ticket.
// The ticket itself is created by @cnote/compliance fileGrievance with category "report" (no new module, no new table).
import { z } from "zod";

export const REPORT_TYPES = ["ipr", "counterfeit", "prohibited", "fraud", "other"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export type ReportField = "url" | "type" | "name" | "email" | "details" | "proof" | "declaration";
/** Keys of `legal.report.err.*` in the messages. */
export type ReportErrorCode = "urlRequired" | "urlInvalid" | "typeRequired" | "nameRequired" | "emailInvalid" | "detailsShort" | "detailsLong" | "proofInvalid" | "declarationRequired";

export interface ReportInput {
  url: string;
  type: ReportType;
  name: string;
  email: string;
  details: string;
  proof: string;
}

export const DETAILS_MIN = 20;
export const DETAILS_MAX = 3000;
const URL_MAX = 2000;

/** Control characters (CR, LF, tab, NUL...). The WHATWG URL parser silently STRIPS tab/CR/LF, so `new URL()` alone would accept them. */
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Collapses CR/LF/tab runs to a space: user text that lands in a ticket subject, email subject or header must stay single-line. */
export const singleLine = (v: string): string => v.replace(/[\r\n\t\u2028\u2029]+/g, " ").trim();

/** http(s) URLs only (no javascript: or data:), at most 2000 characters, no control characters. */
export function isHttpUrl(v: string): boolean {
  if (v.length > URL_MAX || CONTROL.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Prefill from `?url=`: returns the value only when it is a safe http(s) URL, else "". */
export function safePrefillUrl(v: string | null | undefined): string {
  const s = (v ?? "").trim();
  return s && isHttpUrl(s) ? s : "";
}

const str = (raw: Record<string, unknown>, k: string) => (typeof raw[k] === "string" ? (raw[k] as string).trim() : "");
const emailOk = (v: string) => v.length <= 254 && z.email().safeParse(v).success;

export type ReportResult = { ok: true; value: ReportInput } | { ok: false; errors: Partial<Record<ReportField, ReportErrorCode>> };

/** Validates the raw form values (FormData entries). The declaration checkbox arrives as "on" when ticked. */
export function validateReport(raw: Record<string, unknown>): ReportResult {
  const errors: Partial<Record<ReportField, ReportErrorCode>> = {};
  const url = str(raw, "url");
  if (!url) errors.url = "urlRequired";
  else if (!isHttpUrl(url)) errors.url = "urlInvalid";
  const type = str(raw, "type");
  if (!(REPORT_TYPES as readonly string[]).includes(type)) errors.type = "typeRequired";
  const name = str(raw, "name");
  if (name.length < 2) errors.name = "nameRequired";
  const email = str(raw, "email");
  if (!emailOk(email)) errors.email = "emailInvalid";
  const details = str(raw, "details");
  if (details.length < DETAILS_MIN) errors.details = "detailsShort";
  else if (details.length > DETAILS_MAX) errors.details = "detailsLong";
  const proof = str(raw, "proof");
  if (proof && !isHttpUrl(proof)) errors.proof = "proofInvalid";
  if (raw.declaration !== "on" && raw.declaration !== "true") errors.declaration = "declarationRequired";
  if (Object.keys(errors).length) return { ok: false, errors };
  // store the normalised href, never the raw text (defence in depth against header/subject injection)
  return { ok: true, value: { url: new URL(url).href, type: type as ReportType, name: singleLine(name).slice(0, 120), email, details, proof: proof ? new URL(proof).href : "" } };
}

/** Subject (<= 200) and body (<= 5000) of the grievance ticket carrying the report. */
export function reportToTicket(r: ReportInput): { subject: string; body: string } {
  const subject = singleLine(`Report [${r.type}] ${r.url}`).slice(0, 200);
  const body = [
    `Type: ${r.type}`,
    `Reported URL: ${r.url}`,
    `Claimant: ${singleLine(r.name)} <${r.email}>`,
    r.proof ? `Proof: ${r.proof}` : null,
    "Good-faith declaration: accepted",
    "",
    r.details,
  ]
    .filter((l): l is string => l !== null)
    .join("\n")
    .slice(0, 5000);
  return { subject, body };
}
