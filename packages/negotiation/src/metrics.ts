// ADR-014 success metrics from the negotiation tables (the metrics package can call these): draft acceptance, edit distance,
// and time-to-first-quote for assisted vs manual quotes (before/after the assist).
import { prisma } from "@cnote/db";

export interface Range { from?: Date; to?: Date }
const created = (r: Range) => (r.from || r.to ? { createdAt: { ...(r.from ? { gte: r.from } : {}), ...(r.to ? { lt: r.to } : {}) } } : {});
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export interface DraftMetrics {
  generated: number;
  approved: number;
  discarded: number;
  pending: number;
  /** approved / (approved + discarded); null until a draft is decided */
  acceptanceRate: number | null;
  /** approved without any edit / approved */
  uneditedRate: number | null;
  /** mean number of fields changed (of 7) among approved drafts */
  avgEditedFields: number | null;
  /** mean absolute price change vs the draft, percent, among approved drafts */
  avgAbsPriceDeltaPct: number | null;
  /** mean Levenshtein distance of the notes text among approved drafts */
  avgNotesEditDistance: number | null;
  /** agent proposals (draft or counter) the server rejected for breaking bounds */
  boundsRejections: number;
  lowConfidence: number;
}

export async function draftMetrics(range: Range = {}): Promise<DraftMetrics> {
  const rows = await prisma.quoteDraft.findMany({
    where: created(range), select: { status: true, edited: true, editedFields: true, priceDeltaPct: true, notesEditDistance: true, needsReview: true },
  });
  const approved = rows.filter((r) => r.status === "approved");
  const discarded = rows.filter((r) => r.status === "discarded").length;
  const boundsRejections = await prisma.agentActionLog.count({ where: { action: { in: ["draft_bounds_rejected", "counter_bounds_rejected"] }, ...created(range) } });
  return {
    generated: rows.length, approved: approved.length, discarded, pending: rows.length - approved.length - discarded,
    acceptanceRate: approved.length + discarded ? approved.length / (approved.length + discarded) : null,
    uneditedRate: approved.length ? approved.filter((r) => !r.edited).length / approved.length : null,
    avgEditedFields: avg(approved.map((r) => r.editedFields)),
    avgAbsPriceDeltaPct: avg(approved.filter((r) => r.priceDeltaPct != null).map((r) => Math.abs(r.priceDeltaPct!))),
    avgNotesEditDistance: avg(approved.map((r) => r.notesEditDistance)),
    boundsRejections, lowConfidence: rows.filter((r) => r.needsReview).length,
  };
}

export interface Cohort { n: number; meanMs: number | null; medianMs: number | null; p90Ms: number | null }
export interface TimeToFirstQuote { assisted: Cohort; manual: Cohort; /** manual.medianMs - assisted.medianMs; positive = assist is faster */ medianSavedMs: number | null }

function cohort(ms: number[]): Cohort {
  if (!ms.length) return { n: 0, meanMs: null, medianMs: null, p90Ms: null };
  const s = [...ms].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return { n: s.length, meanMs: s.reduce((a, b) => a + b, 0) / s.length, medianMs: s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2, p90Ms: at(0.9) };
}

/** LeadAccepted to first QuoteSent, split by whether the first quote came from an approved agent draft. Leads still unquoted are excluded. */
export async function timeToFirstQuote(range: Range & { sellerBusinessId?: string } = {}): Promise<TimeToFirstQuote> {
  const rows = await prisma.leadQuoteTiming.findMany({
    where: {
      firstQuoteAt: { not: null }, ...(range.sellerBusinessId ? { sellerBusinessId: range.sellerBusinessId } : {}),
      ...(range.from || range.to ? { acceptedAt: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lt: range.to } : {}) } } : {}),
    },
    select: { acceptedAt: true, firstQuoteAt: true, assisted: true }, take: 100_000,
  });
  const ms = (assisted: boolean) => rows.filter((r) => r.assisted === assisted).map((r) => Math.max(0, r.firstQuoteAt!.getTime() - r.acceptedAt.getTime()));
  const assisted = cohort(ms(true)), manual = cohort(ms(false));
  return { assisted, manual, medianSavedMs: assisted.medianMs != null && manual.medianMs != null ? manual.medianMs - assisted.medianMs : null };
}
