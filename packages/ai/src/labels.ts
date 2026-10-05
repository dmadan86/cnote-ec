// Ops labels as training data (ADR-008). A ReviewItem that staff approved or rejected is a human label on an AI
// decision; this module reads them back for the audited admin export. DPDP-safe by construction:
//  - the input is the AiDecision's already-redacted input, re-run through redactDeep (defence in depth), and rows whose
//    input was purged by the 180-day retention job are skipped (nothing left to learn from, and nothing to leak);
//  - the labeller is reported as a role set only: the reviewer's person id is resolved to roles by the caller's
//    `rolesOf` callback and never leaves this function;
//  - subject ids are not exported (only the subject type), the label timestamp is a calendar day, and free text
//    (the queue reason) goes through redactPii.
import { prisma } from "@cnote/db";
import { redactDeep, redactPii } from "./redact";

export interface OpsLabelFilters {
  /** inclusive lower bound on the instant the staff member resolved the item */
  from?: Date;
  /** exclusive upper bound */
  to?: Date;
  capability?: string;
}

/** One labelled decision. No person ids, no subject ids, no staff names or emails. */
export interface OpsLabelRow {
  decisionId: string;
  capability: string;
  subjectType: string;
  /** "approved" = staff confirmed the item may proceed; "rejected" = staff said it must not */
  label: "approved" | "rejected";
  /** UTC calendar day (YYYY-MM-DD) the label was applied */
  labelledOn: string;
  /** sorted role codes of the labeller, ["unknown"] when the staff row is gone */
  labellerRoles: string[];
  provider: string;
  modelId: string;
  promptVersion: string;
  confidence: number;
  /** why the item was queued (redacted) */
  queueReason: string;
  inputRedacted: unknown;
  /** the model's output, redacted */
  output: unknown;
}

export const OPS_LABEL_MAX_ROWS = 250_000;
const PURGED = (v: unknown) => !!v && typeof v === "object" && (v as Record<string, unknown>).purged === true;

/**
 * Streams labelled decisions oldest first (keyset pages on resolvedAt + id, so memory stays flat). `rolesOf` maps
 * reviewer person ids to role codes (the admin app supplies it from @cnote/admin).
 */
export async function* iterateOpsLabels(
  filters: OpsLabelFilters,
  opts: { rolesOf: (personIds: string[]) => Promise<Map<string, string[]>>; maxRows?: number; pageSize?: number },
): AsyncGenerator<OpsLabelRow> {
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? 500, 2000));
  const max = Math.min(opts.maxRows ?? OPS_LABEL_MAX_ROWS, OPS_LABEL_MAX_ROWS);
  let emitted = 0;
  let cursor: { at: Date; id: string } | null = null;
  for (;;) {
    const page: Awaited<ReturnType<typeof loadPage>> = await loadPage(filters, pageSize, cursor);
    if (page.length === 0) return;
    const roles = await opts.rolesOf([...new Set(page.flatMap((r) => (r.resolvedBy ? [r.resolvedBy] : [])))]);
    for (const r of page) {
      const d = r.aiDecision;
      if (!d || PURGED(d.inputRedacted)) continue;
      if (emitted >= max) return;
      emitted++;
      const labeller = r.resolvedBy ? roles.get(r.resolvedBy) : undefined;
      yield {
        decisionId: d.id,
        capability: r.capability,
        subjectType: r.subjectType,
        label: r.status as "approved" | "rejected",
        labelledOn: r.resolvedAt!.toISOString().slice(0, 10),
        labellerRoles: labeller?.length ? [...labeller].sort() : ["unknown"],
        provider: d.provider,
        modelId: d.modelId,
        promptVersion: d.promptVersion,
        confidence: d.confidence,
        queueReason: redactPii(r.reason),
        inputRedacted: redactDeep(d.inputRedacted),
        output: redactDeep(d.output),
      };
    }
    const last = page[page.length - 1]!;
    cursor = { at: last.resolvedAt!, id: last.id };
    if (page.length < pageSize) return;
  }
}

function loadPage(filters: OpsLabelFilters, take: number, cursor: { at: Date; id: string } | null) {
  return prisma.reviewItem.findMany({
    where: {
      status: { in: ["approved", "rejected"] },
      aiDecisionId: { not: null },
      resolvedAt: { not: null, ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lt: filters.to } : {}) },
      aiDecision: { is: { shadow: false } },
      ...(filters.capability ? { capability: filters.capability } : {}),
      ...(cursor ? { OR: [{ resolvedAt: { gt: cursor.at } }, { resolvedAt: cursor.at, id: { gt: cursor.id } }] } : {}),
    },
    orderBy: [{ resolvedAt: "asc" }, { id: "asc" }],
    take,
    include: { aiDecision: true },
  });
}
