// Export of labelled ops decisions (ADR-008): filters and serialisation shared by the page and the route.
// JSONL keeps values exactly as logged (a trainer must see the real strings); CSV neutralises spreadsheet formulas
// (OWASP CSV injection) because that is the format people open in Excel/Sheets.
import { REVIEW_THRESHOLDS, type OpsLabelFilters, type OpsLabelRow } from "@cnote/ai";
import { csvCell } from "../compliance/consent-filters";

const IST = "+05:30";
const DAY_MS = 86_400_000;

/** Capabilities that can have ops labels (the review thresholds plus the families that keep their own). */
export const LABEL_CAPABILITIES = [...Object.keys(REVIEW_THRESHOLDS), "dispute_brief"].sort();
export const LABEL_FORMATS = ["jsonl", "csv"] as const;
export type LabelFormat = (typeof LABEL_FORMATS)[number];

export interface LabelFilterInput { from?: string; to?: string; capability?: string; format?: string }

/** `to` is an inclusive IST calendar day in the UI and an exclusive instant (next midnight IST) in the query. */
export function parseLabelFilters(i: LabelFilterInput): { filters: OpsLabelFilters; format: LabelFormat; problem: string | null } {
  const filters: OpsLabelFilters = {};
  const format: LabelFormat = i.format === "csv" ? "csv" : "jsonl";
  const date = (s: string, end: boolean): Date | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(`${s}T00:00:00${IST}`);
    return Number.isNaN(d.getTime()) ? null : end ? new Date(d.getTime() + DAY_MS) : d;
  };
  if (i.format && !(LABEL_FORMATS as readonly string[]).includes(i.format)) return { filters, format, problem: "Unknown format." };
  if (i.from) {
    const d = date(i.from, false);
    if (!d) return { filters, format, problem: "The start date is not a valid date." };
    filters.from = d;
  }
  if (i.to) {
    const d = date(i.to, true);
    if (!d) return { filters, format, problem: "The end date is not a valid date." };
    filters.to = d;
  }
  if (filters.from && filters.to && filters.from >= filters.to) return { filters, format, problem: "The start date must be on or before the end date." };
  if (i.capability) {
    if (!LABEL_CAPABILITIES.includes(i.capability)) return { filters, format, problem: "Unknown capability." };
    filters.capability = i.capability;
  }
  return { filters, format, problem: null };
}

export const LABEL_CSV_HEADER = ["decision_id", "capability", "subject_type", "label", "labelled_on", "labeller_roles", "provider", "model_id", "prompt_version", "confidence", "queue_reason", "input_redacted", "output"] as const;

export const labelJsonl = (r: OpsLabelRow): string => JSON.stringify(r);

export const labelCsvRow = (r: OpsLabelRow): string =>
  [
    r.decisionId, r.capability, r.subjectType, r.label, r.labelledOn, r.labellerRoles.join("|"), r.provider, r.modelId, r.promptVersion, r.confidence,
    r.queueReason, JSON.stringify(r.inputRedacted), JSON.stringify(r.output),
  ].map(csvCell).join(",");
